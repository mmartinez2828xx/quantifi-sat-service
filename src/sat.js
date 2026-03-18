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
  cerBase64, keyBase64, password, rfc, fechaInicio, fechaFin, tipoSolicitud,
}) {
  console.log(`[SAT] Iniciando ${tipoSolicitud} para RFC ${rfc}`);

  const cerBuffer = Buffer.from(cerBase64, "base64");
  const keyBuffer = Buffer.from(keyBase64, "base64");

  let credential;
  try {
    credential = Credential.create(cerBuffer, keyBuffer, password);
    console.log(`[SAT] Credencial creada para RFC ${rfc}`);
  } catch (err) {
    throw new Error(`Error al leer la e.firma: ${err.message}`);
  }

  const service = ServiceFactory.create(ServiceFactory.newHttpsWebClient());

  // Autenticar
  console.log(`[SAT] Autenticando...`);
  let token;
  try {
    token = await service.authenticate(credential);
    // Log completo para diagnóstico
    console.log(`[SAT] Token tipo:`, typeof token);
    console.log(`[SAT] Token keys:`, token ? Object.keys(token) : 'null');
    console.log(`[SAT] Token raw:`, JSON.stringify(token).substring(0, 300));
    console.log(`[SAT] getToken:`, typeof token.getToken === 'function' ? token.getToken() : 'no existe');
    console.log(`[SAT] getValue:`, typeof token.getValue === 'function' ? token.getValue() : 'no existe');
    console.log(`[SAT] getCreatedAt:`, typeof token.getCreatedAt === 'function' ? token.getCreatedAt() : 'no existe');
  } catch (err) {
    console.log(`[SAT] Error autenticación tipo:`, typeof err);
    console.log(`[SAT] Error autenticación raw:`, JSON.stringify(err));
    console.log(`[SAT] Error autenticación string:`, String(err));
    console.log(`[SAT] Error stack:`, err && err.stack ? err.stack : 'sin stack');
    throw new Error(`Error de autenticación SAT: ${String(err)}`);
  }
  // Verificar token de distintas formas según versión de la librería
  const tokenValue = typeof token.getToken === 'function' ? token.getToken() :
                     typeof token.getValue === 'function' ? token.getValue() :
                     typeof token.value === 'string' ? token.value :
                     token.toString();

  if (!tokenValue || tokenValue === 'undefined' || tokenValue.length < 10) {
    throw new Error(`Token SAT inválido: ${JSON.stringify(token)}`);
  }
  console.log(`[SAT] Autenticación exitosa`);

  // Parámetros de consulta
  const period = DateTimePeriod.create(fechaInicio, fechaFin);
  const downloadType = tipoSolicitud === "emitidos" ? DownloadType.issued() : DownloadType.received();
  const requestType  = tipoSolicitud === "emitidos" ? RequestType.issued()  : RequestType.received();
  const parameters   = QueryParameters.create(period, downloadType, requestType);

  // Solicitar
  console.log(`[SAT] Enviando solicitud...`);
  let queryResult;
  try {
    queryResult = await service.query(credential, parameters);
  } catch (err) {
    throw new Error(`Error al solicitar: ${err.message}`);
  }

  const queryStatus = queryResult.getStatus ? queryResult.getStatus() : queryResult;
  if (!queryStatus.isAccepted()) {
    throw new Error(`Solicitud rechazada: ${queryStatus.getMessage()}`);
  }

  const idSolicitud = queryResult.getRequestId();
  console.log(`[SAT] Solicitud aceptada: ${idSolicitud}`);

  // Polling
  let paquetes = [];
  for (let i = 0; i < 40; i++) {
    await sleep(15000);
    console.log(`[SAT] Verificando (intento ${i + 1}/40)...`);

    let verifyResult;
    try {
      verifyResult = await service.verify(credential, idSolicitud);
    } catch (err) {
      console.warn(`[SAT] Error verificando: ${err.message}`);
      continue;
    }

    const verifyStatus = verifyResult.getStatus ? verifyResult.getStatus() : verifyResult;
    if (!verifyStatus.isAccepted()) {
      console.warn(`[SAT] Verificación no aceptada: ${verifyStatus.getMessage()}`);
      continue;
    }

    const statusRequest = verifyResult.getStatusRequest();
    const statusCode = typeof statusRequest === 'object' ? statusRequest.value : statusRequest;
    console.log(`[SAT] Estado solicitud: ${statusCode}`);

    if (statusCode >= 4) throw new Error(`SAT error en solicitud (código ${statusCode})`);
    if (statusCode === 3) {
      paquetes = verifyResult.getPackageIds();
      console.log(`[SAT] Terminado. ${paquetes.length} paquete(s)`);
      break;
    }
  }

  if (paquetes.length === 0) {
    console.log(`[SAT] Sin CFDIs en el periodo`);
    return [];
  }

  // Descargar paquetes
  const xmls = [];
  for (const packageId of paquetes) {
    console.log(`[SAT] Descargando paquete ${packageId}...`);
    let downloadResult;
    try {
      downloadResult = await service.download(credential, packageId);
    } catch (err) {
      console.warn(`Error descargando paquete: ${err.message}`);
      continue;
    }

    const dlStatus = downloadResult.getStatus ? downloadResult.getStatus() : downloadResult;
    if (!dlStatus.isAccepted()) {
      console.warn(`Paquete rechazado: ${dlStatus.getMessage()}`);
      continue;
    }

    const content = downloadResult.getPackageContent();
    const zipBuffer = Buffer.from(content, "base64");
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
