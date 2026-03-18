const {
  ServiceFactory,
  QueryParameters,
  DateTimePeriod,
  DownloadType,
  RequestType,
} = require("@nodecfdi/sat-ws-descarga-masiva");
const { Credential } = require("@nodecfdi/credentials");
const AdmZip = require("adm-zip");

async function descargarCfdis({
  cerBase64,
  keyBase64,
  password,
  rfc,
  fechaInicio,
  fechaFin,
  tipoSolicitud,
}) {
  console.log(`[SAT] Iniciando ${tipoSolicitud} para RFC ${rfc}`);

  const cerBuffer = Buffer.from(cerBase64, "base64");
  const keyBuffer = Buffer.from(keyBase64, "base64");
  const credential = Credential.create(cerBuffer, keyBuffer, password);

  const service = ServiceFactory.create(ServiceFactory.newHttpsWebClient());

  const period = DateTimePeriod.create(fechaInicio, fechaFin);

  const downloadType =
    tipoSolicitud === "emitidos" ? DownloadType.issued() : DownloadType.received();
  const requestType =
    tipoSolicitud === "emitidos" ? RequestType.issued() : RequestType.received();

  const parameters = QueryParameters.create(period, downloadType, requestType);

  console.log(`[SAT] Enviando solicitud...`);
  const queryResult = await service.query(credential, parameters);

  if (!queryResult.getStatus().isAccepted()) {
    throw new Error(`Solicitud rechazada: ${queryResult.getStatus().getMessage()}`);
  }

  const idSolicitud = queryResult.getRequestId();
  console.log(`[SAT] Solicitud aceptada: ${idSolicitud}`);

  let paquetes = [];
  const MAX_INTENTOS = 40;

  for (let i = 0; i < MAX_INTENTOS; i++) {
    await sleep(15000);
    console.log(`[SAT] Verificando (intento ${i + 1}/${MAX_INTENTOS})...`);

    const verifyResult = await service.verify(credential, idSolicitud);

    if (!verifyResult.getStatus().isAccepted()) {
      console.warn(`[SAT] Error verificando: ${verifyResult.getStatus().getMessage()}`);
      continue;
    }

    const statusCode = verifyResult.getStatusRequest().value;

    if (statusCode >= 4) {
      throw new Error(`SAT devolvió error (código ${statusCode})`);
    }

    if (statusCode === 3) {
      paquetes = verifyResult.getPackageIds();
      console.log(`[SAT] Terminado. ${paquetes.length} paquete(s)`);
      break;
    }

    console.log(`[SAT] En proceso (estado ${statusCode}). Esperando...`);
  }

  if (paquetes.length === 0) {
    console.log(`[SAT] Sin CFDIs en el periodo`);
    return [];
  }

  const xmls = [];
  for (const packageId of paquetes) {
    console.log(`[SAT] Descargando paquete ${packageId}...`);
    const downloadResult = await service.download(credential, packageId);

    if (!downloadResult.getStatus().isAccepted()) {
      console.warn(`Error en paquete ${packageId}: ${downloadResult.getStatus().getMessage()}`);
      continue;
    }

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
