const {
  Service,
  ServiceEndpoints,
  SatHttpsGateway,
  FielRequestBuilder,
  QueryParameters,
  DateTimePeriod,
  DownloadType,
  RequestType,
} = require("@nodecfdi/sat-ws-descarga-masiva");
const { Credential } = require("@nodecfdi/credentials");
const AdmZip = require("adm-zip");

async function descargarCfdis({
  cerBase64, keyBase64, password, rfc, fechaInicio, fechaFin, tipoSolicitud,
}) {
  console.log(`[SAT] Iniciando ${tipoSolicitud} para RFC ${rfc}`);

  const cerBuffer = Buffer.from(cerBase64, "base64");
  const keyBuffer = Buffer.from(keyBase64, "base64");

  const credential = Credential.create(cerBuffer, keyBuffer, password);
  const fiel = credential.fiel();

  if (!fiel.isValid()) {
    throw new Error(`e.firma no válida o vencida para RFC ${rfc}`);
  }
  console.log(`[SAT] FIEL válida`);

  const requestBuilder = new FielRequestBuilder(fiel);
  const gateway = new SatHttpsGateway();
  const endpoints = ServiceEndpoints.cfdi();
  const service = new Service(requestBuilder, gateway, endpoints);

  console.log(`[SAT] Autenticando...`);
  const token = await service.authenticate();

  if (!token.isValueValid()) {
    throw new Error(`Token SAT inválido`);
  }
  console.log(`[SAT] Autenticación exitosa`);

  const downloadType = tipoSolicitud === "emitidos" ? DownloadType.issued() : DownloadType.received();
  const requestType  = tipoSolicitud === "emitidos" ? RequestType.issued()  : RequestType.received();
  const period = DateTimePeriod.create(fechaInicio, fechaFin);
  const parameters = QueryParameters.create(period, downloadType, requestType);

  console.log(`[SAT] Enviando solicitud...`);
  const queryResult = await service.query(parameters);

  if (!queryResult.getStatus().isAccepted()) {
    throw new Error(`Solicitud rechazada: ${queryResult.getStatus().getMessage()}`);
  }

  const idSolicitud = queryResult.getRequestId();
  console.log(`[SAT] Solicitud aceptada: ${idSolicitud}`);

  let paquetes = [];
  for (let i = 0; i < 40; i++) {
    await sleep(15000);
    console.log(`[SAT] Verificando intento ${i + 1}/40...`);

    const verifyResult = await service.verify(idSolicitud);

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
    const downloadResult = await service.download(packageId);

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
