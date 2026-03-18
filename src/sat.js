const {
  ServiceFactory,
  QueryParameters,
  DateTimePeriod,
  DownloadType,
  RequestType,
} = require("@nodecfdi/sat-ws-descarga-masiva");
const { Fiel } = require("@nodecfdi/credentials");
const AdmZip = require("adm-zip");

async function descargarCfdis({
  cerBase64, keyBase64, password, rfc, fechaInicio, fechaFin, tipoSolicitud,
}) {
  console.log(`[SAT] Iniciando ${tipoSolicitud} para RFC ${rfc}`);

  const cerBuffer = Buffer.from(cerBase64, "base64");
  const keyBuffer = Buffer.from(keyBase64, "base64");

  let fiel;
  try {
    fiel = Fiel.create(cerBuffer, keyBuffer, password);
    console.log(`[SAT] FIEL creada correctamente`);
  } catch (err) {
    throw new Error(`Error al leer la e.firma: ${String(err)}`);
  }

  if (!fiel.isValid()) {
    throw new Error(`La e.firma no es válida o está vencida`);
  }

  const service = ServiceFactory.create(ServiceFactory.newHttpsWebClient());

  console.log(`[SAT] Autenticando con FIEL...`);
  let token;
  try {
    token = await service.authenticate(fiel);
    console.log(`[SAT] Token recibido, tipo: ${typeof token}`);
    console.log(`[SAT] Token keys: ${Object.keys(token || {}).join(', ')}`);
  } catch (err) {
    throw new Error(`Error de autenticación: ${String(err)}`);
  }

  if (!token || !token.isValid || !token.isValid()) {
    throw new Error(`Token SAT inválido después de autenticar`);
  }
  console.log(`[SAT] Autenticación exitosa`);

  const period = DateTimePeriod.create(fechaInicio, fechaFin);
  const downloadType = tipoSolicitud === "emitidos" ? DownloadType.issued() : DownloadType.received();
  const requestType  = tipoSolicitud === "emitidos" ? RequestType.issued()  : RequestType.received();
  const parameters   = QueryParameters.create(period, downloadType, requestType);

  console.log(`[SAT] Enviando solicitud...`);
  let queryResult;
  try {
    queryResult = await service.query(fiel, parameters);
  } catch (err) {
    throw new Error(`Error al solicitar: ${String(err)}`);
  }

  if (!queryResult.getStatus().isAccepted()) {
    throw new Error(`Solicitud rechazada: ${queryResult.getStatus().getMessage()}`);
  }

  const idSolicitud = queryResult.getRequestId();
  console.log(`[SAT] Solicitud aceptada: ${idSolicitud}`);

  let paquetes = [];
  for (let i = 0; i < 40; i++) {
    await sleep(15000);
    console.log(`[SAT] Verificando intento ${i + 1}/40...`);

    let verifyResult;
    try {
      verifyResult = await service.verify(fiel, idSolicitud);
    } catch (err) {
      console.warn(`[SAT] Error verificando: ${String(err)}`);
      continue;
    }

    if (!verifyResult.getStatus().isAccepted()) continue;

    const statusCode = verifyResult.getStatusRequest().value;
    console.log(`[SAT] Estado: ${statusCode}`);

    if (statusCode >= 4) throw new Error(`SAT error código ${statusCode}`);
    if (statusCode === 3) {
      paquetes = verifyResult.getPackageIds();
      console.log(`[SAT] Listo. ${paquetes.length} paquete(s)`);
      break;
    }
  }

  if (paquetes.length === 0) {
    console.log(`[SAT] Sin CFDIs en el periodo`);
    return [];
  }

  const xmls = [];
  for (const packageId of paquetes) {
    console.log(`[SAT] Descargando paquete ${packageId}...`);
    let downloadResult;
    try {
      downloadResult = await service.download(fiel, packageId);
    } catch (err) {
      console.warn(`Error descargando: ${String(err)}`);
      continue;
    }

    if (!downloadResult.getStatus().isAccepted()) continue;

    const zipBuffer = Buffer.from(downloadResult.getPackageContent(), "base64");
    const zip = new AdmZip(zipBuffer);
    for (const entry of zip.getEntries()) {
      if (entry.entryName.endsWith(".xml")) {
        xmls.push(entry.getData().toString("utf8"));
      }
    }
  }

  console.log(`[SAT] Total ${tipoSolicitud}: ${xmls.length} XMLs`);
  return xmls;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { descargarCfdis };
