require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { descargarCfdis } = require("./sat");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const API_KEY = process.env.API_KEY;

function authMiddleware(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "API key inválida" });
  }
  next();
}
app.use(authMiddleware);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/descargar-una", async (req, res) => {
  const { empresaId } = req.body;
  if (!empresaId) {
    return res.status(400).json({ error: "empresaId es requerido" });
  }

  try {
    const { data: efirma, error: efError } = await supabase
      .from("empresa_efirmas")
      .select("*")
      .eq("empresa_id", empresaId)
      .eq("activa", true)
      .single();

    if (efError || !efirma) {
      return res.status(404).json({ error: "No se encontró e.firma activa" });
    }

    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    const fechaInicio = new Date(ayer);
    fechaInicio.setHours(0, 0, 0, 0);
    const fechaFin = new Date(ayer);
    fechaFin.setHours(23, 59, 59, 999);

    const { data: solicitud, error: solError } = await supabase
      .from("sat_solicitudes")
      .insert({
        empresa_id: empresaId,
        rfc: efirma.rfc,
        tipo: "ambos",
        fecha_inicio: fechaInicio.toISOString().split("T")[0],
        fecha_fin: fechaFin.toISOString().split("T")[0],
        estado: "procesando",
      })
      .select()
      .single();

    if (solError) {
      return res.status(500).json({ error: "Error al registrar solicitud" });
    }

    res.json({ message: "Descarga iniciada", solicitudId: solicitud.id });

    procesarDescarga(efirma, solicitud.id, empresaId, fechaInicio, fechaFin);

  } catch (err) {
    console.error("Error general:", err);
    res.status(500).json({ error: err.message });
  }
});

async function procesarDescarga(efirma, solicitudId, empresaId, fechaInicio, fechaFin) {
  try {
    console.log(`[${solicitudId}] Iniciando para RFC ${efirma.rfc}...`);

    const xmlsRecibidos = await descargarCfdis({
      cerBase64: efirma.cer_base64,
      keyBase64: efirma.key_base64,
      password: efirma.password,
      rfc: efirma.rfc,
      fechaInicio,
      fechaFin,
      tipoSolicitud: "recibidos",
    });

    const xmlsEmitidos = await descargarCfdis({
      cerBase64: efirma.cer_base64,
      keyBase64: efirma.key_base64,
      password: efirma.password,
      rfc: efirma.rfc,
      fechaInicio,
      fechaFin,
      tipoSolicitud: "emitidos",
    });

    const todosXmls = [...xmlsRecibidos, ...xmlsEmitidos];
    console.log(`[${solicitudId}] ${todosXmls.length} XMLs obtenidos`);

    let cfdisNuevos = 0;
    for (const xml of todosXmls) {
      try {
        const datos = parsearCfdiXml(xml, empresaId, efirma.rfc);
        const { error } = await supabase
          .from("cfdis")
          .upsert(datos, { onConflict: "uuid_fiscal,empresa_id" });
        if (!error) cfdisNuevos++;
      } catch (parseErr) {
        console.warn(`Error parseando XML:`, parseErr.message);
      }
    }

    await supabase
      .from("sat_solicitudes")
      .update({
        estado: "completado",
        cfdis_nuevos: cfdisNuevos,
        completado_at: new Date().toISOString(),
      })
      .eq("id", solicitudId);

    console.log(`[${solicitudId}] Completado: ${cfdisNuevos} CFDIs nuevos`);

  } catch (err) {
    console.error(`[${solicitudId}] Error:`, err);
    await supabase
      .from("sat_solicitudes")
      .update({ estado: "error", completado_at: new Date().toISOString() })
      .eq("id", solicitudId);
  }
}

function parsearCfdiXml(xmlString, empresaId, rfcEmpresa) {
  const attr = (tag, name) => {
    const re = new RegExp(`<[^>]*${tag}[^>]*${name}="([^"]*)"`, "i");
    const m = xmlString.match(re);
    return m ? m[1] : null;
  };

  const uuid = attr("tfd:TimbreFiscalDigital", "UUID") || attr("TimbreFiscalDigital", "UUID");
  if (!uuid) throw new Error("XML sin UUID");

  const rfcEmisor   = attr("cfdi:Emisor",    "Rfc") || attr("Emisor",    "Rfc");
  const rfcReceptor = attr("cfdi:Receptor",  "Rfc") || attr("Receptor",  "Rfc");
  const direccion   = rfcEmisor === rfcEmpresa ? "emitido" : "recibido";

  const tipoRaw = attr("cfdi:Comprobante", "TipoDeComprobante") || attr("Comprobante", "TipoDeComprobante") || "I";
  const tipoMap = { I: "ingreso", E: "egreso", T: "traslado", P: "pago", N: "nomina" };

  const total      = parseFloat(attr("cfdi:Comprobante", "Total")      || attr("Comprobante", "Total")      || "0");
  const subtotal   = parseFloat(attr("cfdi:Comprobante", "SubTotal")   || attr("Comprobante", "SubTotal")   || "0");
  const moneda     = attr("cfdi:Comprobante", "Moneda")                || attr("Comprobante", "Moneda")     || "MXN";
  const tipoCambio = parseFloat(attr("cfdi:Comprobante", "TipoCambio") || attr("Comprobante", "TipoCambio") || "1");

  return {
    uuid_fiscal:     uuid.toUpperCase(),
    empresa_id:      empresaId,
    tipo:            tipoMap[tipoRaw] || tipoRaw.toLowerCase(),
    direccion,
    rfc_emisor:      rfcEmisor,
    nombre_emisor:   attr("cfdi:Emisor",    "Nombre") || attr("Emisor",    "Nombre"),
    rfc_receptor:    rfcReceptor,
    nombre_receptor: attr("cfdi:Receptor",  "Nombre") || attr("Receptor",  "Nombre"),
    uso_cfdi:        attr("cfdi:Receptor",  "UsoCFDI") || attr("Receptor", "UsoCFDI"),
    total,
    subtotal,
    moneda,
    tipo_cambio:     tipoCambio,
    total_mxn:       moneda === "MXN" ? total : total * tipoCambio,
    metodo_pago:     attr("cfdi:Comprobante", "MetodoPago") || attr("Comprobante", "MetodoPago"),
    forma_pago:      attr("cfdi:Comprobante", "FormaPago")  || attr("Comprobante", "FormaPago"),
    serie:           attr("cfdi:Comprobante", "Serie")      || attr("Comprobante", "Serie"),
    folio:           attr("cfdi:Comprobante", "Folio")      || attr("Comprobante", "Folio"),
    fecha_emision:   attr("cfdi:Comprobante", "Fecha")      || attr("Comprobante", "Fecha"),
    fecha_timbrado:  attr("tfd:TimbreFiscalDigital", "FechaTimbrado") || attr("TimbreFiscalDigital", "FechaTimbrado"),
    estado_sat:      "vigente",
    xml_raw:         xmlString,
    fecha_importacion: new Date().toISOString(),
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`quantifi-sat-service corriendo en puerto ${PORT}`);
});
