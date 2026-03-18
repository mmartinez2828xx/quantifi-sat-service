require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { descargarCfdis } = require("./sat");

const app = express();
app.use(cors());
app.use(express.json());

const sanitizeEnv = (value) => {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^['"]|['"]$/g, "");
};

const SUPABASE_URL = sanitizeEnv(process.env.SUPABASE_URL);
const DEFAULT_SUPABASE_KEY = sanitizeEnv(
  process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY
);
const API_KEY = sanitizeEnv(process.env.API_KEY);

if (!SUPABASE_URL) {
  console.error("❌ Falta SUPABASE_URL en variables de entorno");
  process.exit(1);
}

if (!DEFAULT_SUPABASE_KEY) {
  console.warn("⚠️ No hay llave Supabase por default en env; se esperará x-supabase-anon-key por request");
}

function getSupabaseClient() {
  return createClient(SUPABASE_URL, DEFAULT_SUPABASE_KEY);
}

// ── Middleware de autenticación ──
function authMiddleware(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "API key inválida" });
  }
  next();
}

app.use(authMiddleware);

// ── Health check ──
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    config: {
      has_supabase_url: !!SUPABASE_URL,
      has_default_supabase_key: !!DEFAULT_SUPABASE_KEY,
    },
  });
});

// ══════════════════════════════════════════════════════════════
// NEW: /sat/verificar-y-descargar
// Called by Edge Function (fire-and-forget) AFTER Auth + Solicitud
// Receives: id_solicitud_sat (SAT's request ID)
// Does: Polling → Download ZIP → Parse XMLs → Save to Supabase
// ══════════════════════════════════════════════════════════════
app.post("/sat/verificar-y-descargar", async (req, res) => {
  const { solicitud_id, empresa_id, importacion_id, rfc, tipo, id_solicitud_sat } = req.body;

  if (!solicitud_id || !empresa_id || !id_solicitud_sat) {
    return res.status(400).json({ error: "solicitud_id, empresa_id y id_solicitud_sat son requeridos" });
  }

  // Respond immediately — processing happens in background
  res.json({ message: "Verificación y descarga iniciada", solicitud_id });

  // Background processing
  procesarVerificacionYDescarga(solicitud_id, empresa_id, importacion_id, rfc, tipo, id_solicitud_sat);
});

async function procesarVerificacionYDescarga(solicitudId, empresaId, importacionId, rfc, tipo, idSolicitudSat) {
  const supabase = getSupabaseClient();

  try {
    console.log(`[${solicitudId}] Iniciando verificación SAT para solicitud SAT: ${idSolicitudSat}`);

    // 1. Load FIEL from DB
    const { data: efirma, error: efError } = await supabase
      .from("empresa_efirmas")
      .select("*")
      .eq("empresa_id", empresaId)
      .eq("activa", true)
      .single();

    if (efError || !efirma) {
      throw new Error("No se encontró e.firma activa para esta empresa");
    }

    // 2. Use the @nodecfdi library for verify + download
    const { Credential } = require("@nodecfdi/credentials");
    const {
      SatHttpsGateway,
      FielRequestBuilder,
      Service,
      ServiceEndpoints,
    } = require("@nodecfdi/sat-ws-descarga-masiva");

    const cerBuffer = Buffer.from(efirma.cer_base64, "base64");
    const keyBuffer = Buffer.from(efirma.key_base64, "base64");
    const credential = Credential.create(cerBuffer, keyBuffer, efirma.password);
    const fiel = credential.fiel();

    if (!fiel.isValid()) {
      throw new Error("La FIEL no es válida o está vencida");
    }

    const requestBuilder = new FielRequestBuilder(fiel);
    const gateway = new SatHttpsGateway();
    const endpoints = ServiceEndpoints.cfdi();
    const service = new Service(requestBuilder, gateway, endpoints);

    // 3. Authenticate
    console.log(`[${solicitudId}] Autenticando con SAT...`);
    const authResult = await service.authenticate();
    if (!authResult.isSuccess()) {
      throw new Error(`Error de autenticación SAT: ${authResult.getMessage()}`);
    }
    console.log(`[${solicitudId}] ✅ Autenticación exitosa`);

    // 4. Polling: verify until ready (max ~23 min)
    const MAX_INTENTOS = 46; // 46 * 30s = 23 min
    let paquetes = [];
    let intentos = 0;

    while (intentos < MAX_INTENTOS) {
      intentos++;
      console.log(`[${solicitudId}] Verificando solicitud SAT ${idSolicitudSat} (intento ${intentos}/${MAX_INTENTOS})...`);

      await sleep(30000);

      const verifyResult = await service.verify(idSolicitudSat);

      if (!verifyResult.isSuccess()) {
        console.warn(`[${solicitudId}] Verificación falló: ${verifyResult.getMessage()}`);
        continue;
      }

      const statusCode = verifyResult.getStatusRequest().value;
      console.log(`[${solicitudId}] Estado SAT: ${statusCode}`);

      if (statusCode >= 4) {
        throw new Error(`Solicitud rechazada/error por el SAT (código ${statusCode})`);
      }

      if (statusCode === 3) {
        paquetes = verifyResult.getPackageIds();
        console.log(`[${solicitudId}] ✅ Solicitud terminada. ${paquetes.length} paquete(s)`);

        const numeroCfdis = verifyResult.getNumberCfdis ? verifyResult.getNumberCfdis() : 0;
        await supabase
          .from("sat_solicitudes")
          .update({
            paquete_ids: paquetes,
            numero_cfdis: numeroCfdis,
            updated_at: new Date().toISOString(),
          })
          .eq("id", solicitudId);
        break;
      }
    }

    if (intentos >= MAX_INTENTOS && paquetes.length === 0) {
      throw new Error("Timeout: La solicitud SAT no se completó en 23 minutos");
    }

    if (paquetes.length === 0) {
      console.log(`[${solicitudId}] No se encontraron CFDIs`);
      await supabase
        .from("sat_solicitudes")
        .update({
          estado: "completado",
          cfdis_nuevos: 0,
          cfdis_descargados: 0,
          completado_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", solicitudId);

      if (importacionId) await updateImportacionIfAllDone(supabase, importacionId);
      return;
    }

    // 5. Download each package
    const AdmZip = require("adm-zip");
    let cfdisNuevos = 0;

    for (const packageId of paquetes) {
      console.log(`[${solicitudId}] Descargando paquete ${packageId}...`);

      const downloadResult = await service.download(packageId);

      if (!downloadResult.isSuccess()) {
        console.warn(`[${solicitudId}] Error descargando paquete ${packageId}: ${downloadResult.getMessage()}`);
        continue;
      }

      const zipBase64 = downloadResult.getContent();
      const zipBuffer = Buffer.from(zipBase64, "base64");
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();

      console.log(`[${solicitudId}] Paquete ${packageId}: ${entries.length} archivos`);

      for (const entry of entries) {
        if (!entry.entryName.endsWith(".xml")) continue;

        try {
          const xmlContent = entry.getData().toString("utf8");
          const datos = parsearCfdiXml(xmlContent, empresaId, rfc);
          if (!datos) continue;

          datos.direccion = tipo === "emitidos" ? "emitido" : "recibido";

          const { error: insertErr } = await supabase
            .from("cfdis")
            .upsert(datos, { onConflict: "uuid_fiscal,empresa_id" });

          if (!insertErr) cfdisNuevos++;
          else console.warn(`[${solicitudId}] Error insertando CFDI:`, insertErr.message);
        } catch (parseErr) {
          console.warn(`[${solicitudId}] Error parseando XML:`, parseErr.message);
        }
      }
    }

    // 6. Update as completed
    await supabase
      .from("sat_solicitudes")
      .update({
        estado: "completado",
        cfdis_nuevos: cfdisNuevos,
        cfdis_descargados: cfdisNuevos,
        completado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", solicitudId);

    console.log(`[${solicitudId}] ✅ Completado: ${cfdisNuevos} CFDIs nuevos`);

    if (importacionId) await updateImportacionIfAllDone(supabase, importacionId);
  } catch (err) {
    console.error(`[${solicitudId}] ❌ Error:`, err.message || err);

    await supabase
      .from("sat_solicitudes")
      .update({
        estado: "error",
        error_mensaje: (err.message || "Error desconocido").substring(0, 500),
        completado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", solicitudId);

    if (importacionId) await updateImportacionIfAllDone(supabase, importacionId);
  }
}

async function updateImportacionIfAllDone(supabase, importacionId) {
  try {
    const { data: allSols } = await supabase
      .from("sat_solicitudes")
      .select("estado, cfdis_descargados, cfdis_nuevos")
      .eq("importacion_id", importacionId);

    if (!allSols || allSols.length === 0) return;

    const allDone = allSols.every((s) => ["completado", "error"].includes(s.estado));
    if (!allDone) return;

    const totalCfdis = allSols.reduce((sum, s) => sum + (s.cfdis_descargados || s.cfdis_nuevos || 0), 0);
    const hasSuccess = allSols.some((s) => s.estado === "completado");

    await supabase.from("importaciones_sat").update({
      estado: hasSuccess ? "completada" : "error",
      cfdis_descargados: totalCfdis,
    }).eq("id", importacionId);

    console.log(`[importacion ${importacionId}] Actualizada: ${hasSuccess ? "completada" : "error"}, ${totalCfdis} CFDIs`);
  } catch (e) {
    console.error(`Error updating importacion ${importacionId}:`, e);
  }
}

// ── Parser de CFDI XML → objeto para Supabase ──
function parsearCfdiXml(xmlString, empresaId, rfcEmpresa) {
  const attr = (tag, name) => {
    const re = new RegExp(`<[^>]*${tag}[^>]*${name}="([^"]*)"`, "i");
    const m = xmlString.match(re);
    return m ? m[1] : null;
  };

  const uuid = attr("tfd:TimbreFiscalDigital", "UUID") || attr("TimbreFiscalDigital", "UUID");
  if (!uuid) return null;

  const rfcEmisor = attr("cfdi:Emisor", "Rfc") || attr("Emisor", "Rfc");
  const rfcReceptor = attr("cfdi:Receptor", "Rfc") || attr("Receptor", "Rfc");
  const direccion = rfcEmisor === rfcEmpresa ? "emitido" : "recibido";

  const tipoRaw = attr("cfdi:Comprobante", "TipoDeComprobante") || attr("Comprobante", "TipoDeComprobante") || "I";
  const tipoMap = { I: "ingreso", E: "egreso", T: "traslado", P: "pago", N: "nomina" };

  const total = parseFloat(attr("cfdi:Comprobante", "Total") || attr("Comprobante", "Total") || "0");
  const subtotal = parseFloat(attr("cfdi:Comprobante", "SubTotal") || attr("Comprobante", "SubTotal") || "0");
  const moneda = attr("cfdi:Comprobante", "Moneda") || attr("Comprobante", "Moneda") || "MXN";
  const tipoCambio = parseFloat(attr("cfdi:Comprobante", "TipoCambio") || attr("Comprobante", "TipoCambio") || "1");
  const metodoPago = attr("cfdi:Comprobante", "MetodoPago") || attr("Comprobante", "MetodoPago");
  const formaPago = attr("cfdi:Comprobante", "FormaPago") || attr("Comprobante", "FormaPago");

  return {
    uuid_fiscal: uuid.toUpperCase(),
    empresa_id: empresaId,
    tipo: tipoMap[tipoRaw] || tipoRaw.toLowerCase(),
    direccion,
    rfc_emisor: rfcEmisor,
    nombre_emisor: attr("cfdi:Emisor", "Nombre") || attr("Emisor", "Nombre"),
    rfc_receptor: rfcReceptor,
    nombre_receptor: attr("cfdi:Receptor", "Nombre") || attr("Receptor", "Nombre"),
    uso_cfdi: attr("cfdi:Receptor", "UsoCFDI") || attr("Receptor", "UsoCFDI"),
    total,
    subtotal,
    moneda,
    tipo_cambio: tipoCambio,
    total_mxn: moneda === "MXN" ? total : total * tipoCambio,
    metodo_pago: metodoPago,
    forma_pago: formaPago,
    serie: attr("cfdi:Comprobante", "Serie") || attr("Comprobante", "Serie"),
    folio: attr("cfdi:Comprobante", "Folio") || attr("Comprobante", "Folio"),
    fecha_emision: attr("cfdi:Comprobante", "Fecha") || attr("Comprobante", "Fecha"),
    fecha_timbrado: attr("tfd:TimbreFiscalDigital", "FechaTimbrado") || attr("TimbreFiscalDigital", "FechaTimbrado"),
    estado_sat: "vigente",
    xml_raw: xmlString,
    fecha_importacion: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// LEGACY: /sat/descargar — backward compat (full flow)
// ══════════════════════════════════════════════════════════════
app.post("/sat/descargar", async (req, res) => {
  const { solicitud_id, empresa_id, importacion_id, rfc, tipo, fecha_desde, fecha_hasta } = req.body;

  if (!solicitud_id || !empresa_id) {
    return res.status(400).json({ error: "solicitud_id y empresa_id son requeridos" });
  }

  res.json({ message: "Descarga iniciada", solicitud_id });
  procesarDescargaCompleta(solicitud_id, empresa_id, importacion_id, rfc, tipo, fecha_desde, fecha_hasta);
});

async function procesarDescargaCompleta(solicitudId, empresaId, importacionId, rfc, tipo, fechaDesde, fechaHasta) {
  const supabase = getSupabaseClient();

  try {
    const { data: efirma, error: efError } = await supabase
      .from("empresa_efirmas")
      .select("*")
      .eq("empresa_id", empresaId)
      .eq("activa", true)
      .single();

    if (efError || !efirma) throw new Error("No se encontró e.firma activa");

    const xmls = await descargarCfdis({
      cerBase64: efirma.cer_base64,
      keyBase64: efirma.key_base64,
      password: efirma.password,
      rfc: efirma.rfc || rfc,
      fechaInicio: new Date(`${fechaDesde}T00:00:00`),
      fechaFin: new Date(`${fechaHasta}T23:59:59`),
      tipoSolicitud: tipo,
    });

    let cfdisNuevos = 0;
    for (const xml of xmls) {
      try {
        const datos = parsearCfdiXml(xml, empresaId, efirma.rfc || rfc);
        if (!datos) continue;
        const { error: insertErr } = await supabase
          .from("cfdis")
          .upsert(datos, { onConflict: "uuid_fiscal,empresa_id" });
        if (!insertErr) cfdisNuevos++;
      } catch (e) { console.warn("Parse error:", e.message); }
    }

    await supabase.from("sat_solicitudes").update({
      estado: "completado", cfdis_nuevos: cfdisNuevos, cfdis_descargados: cfdisNuevos,
      completado_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", solicitudId);

    if (importacionId) await updateImportacionIfAllDone(supabase, importacionId);
  } catch (err) {
    console.error(`[${solicitudId}] ❌`, err.message);
    await supabase.from("sat_solicitudes").update({
      estado: "error", error_mensaje: (err.message || "").substring(0, 500),
      completado_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", solicitudId);
    if (importacionId) await updateImportacionIfAllDone(supabase, importacionId);
  }
}

// ══════════════════════════════════════════════════════════════
// LEGACY: /descargar-una
// ══════════════════════════════════════════════════════════════
app.post("/descargar-una", async (req, res) => {
  const { empresaId } = req.body;
  if (!empresaId) return res.status(400).json({ error: "empresaId es requerido" });

  const supabase = getSupabaseClient();
  try {
    const { data: efirma, error: efError } = await supabase
      .from("empresa_efirmas").select("*").eq("empresa_id", empresaId).eq("activa", true).single();
    if (efError || !efirma) return res.status(404).json({ error: "No e.firma activa" });

    const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
    const f1 = new Date(ayer); f1.setHours(0,0,0,0);
    const f2 = new Date(ayer); f2.setHours(23,59,59,999);

    const { data: solicitud, error: solError } = await supabase.from("sat_solicitudes").insert({
      empresa_id: empresaId, rfc: efirma.rfc, tipo: "ambos",
      fecha_inicio: f1.toISOString().split("T")[0], fecha_fin: f2.toISOString().split("T")[0], estado: "procesando",
    }).select().single();

    if (solError) return res.status(500).json({ error: solError.message });
    res.json({ message: "Descarga iniciada", solicitudId: solicitud.id });

    procesarDescargaCompleta(solicitud.id, empresaId, null, efirma.rfc, "ambos",
      f1.toISOString().split("T")[0], f2.toISOString().split("T")[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 quantifi-sat-service corriendo en puerto ${PORT}`); });
