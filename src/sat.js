require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { descargarCfdis } = require("./sat");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
  const { empresaId, efirma } = req.body;
  if (!empresaId) {
    return res.status(400).json({ error: "empresaId es requerido" });
  }

  try {
    let cerBase64, keyBase64, password, rfc;

    if (efirma) {
      // Los datos vienen directo del frontend
      cerBase64 = efirma.cer_base64;
      keyBase64  = efirma.key_base64;
      password   = efirma.password;
      rfc        = efirma.rfc;
    } else {
      // Buscar en Supabase
      const { data, error } = await supabase
        .from("empresa_efirmas")
        .select("*")
        .eq("empresa_id", empresaId)
        .eq("activa", true)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: "No se encontró e.firma activa" });
      }
      cerBase64 = data.cer_base64;
      keyBase64  = data.key_base64;
      password   = data.password;
      rfc        = data.rfc;
    }

    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    const fechaInicio = new Date(ayer); fechaInicio.setHours(0, 0, 0, 0);
    const fechaFin    = new Date(ayer); fechaFin.setHours(23, 59, 59, 999);

    const { data: solicitud } = await supabase
      .from("sat_solicitudes")
      .insert({
        empresa_id:   empresaId,
        rfc,
        tipo:         "ambos",
        fecha_inicio: fechaInicio.toISOString().split("T")[0],
        fecha_fin:    fechaFin.toISOString().split("T")[0],
        estado:       "procesando",
      })
      .select()
      .single();

    res.json({ message: "Descarga iniciada", solicitudId: solicitud?.id });

    // Proceso en background
    procesarDescarga({ cerBase64, keyBase64, password, rfc }, solicitud?.id, empresaId, fechaInicio, fechaFin);

  } catch (err) {
    console.error("Error general:", err);
    res.status(500).json({ error: err.message });
  }
});

async function procesarDescarga(efirmaData, solicitudId, empresaId, fechaInicio, fechaFin) {
  let cfdisNuevos = 0;
  try {
    console.log(`[${solicitudId}] Iniciando descarga para RFC ${efirmaData.rfc}`);

    for (const tipo of ["recibidos", "emitidos"]) {
      try {
        const xmls = await descargarCfdis({ ...efirmaData, fechaInicio, fechaFin, tipoSolicitud: tipo });
        console.log(`[${solicitudId}] ${tipo}: ${xmls.length} XMLs`);

        for (const xml of xmls) {
          try {
            const datos = parsearCfdiXml(xml, empresaId, efirmaData.rfc);
            const { error } = await supabase
              .from("cfdis")
              .upsert(datos, { onConflict: "uuid_fiscal,empresa_id" });
            if (!error) cfdisNuevos++;
          } catch (e) {
            console.warn("Error parseando XML:", e.message);
          }
        }
      } catch (e) {
        console.error(`Error en ${tipo}:`, e.message);
      }
    }

    await supabase.from("sat_solicitudes")
      .update({ estado: "completado", cfdis_nuevos: cfdisNuevos, completado_at: new Date() })
      .eq("id", solicitudId);

    console.log(`[${solicitudId}] Completado: ${cfdisNuevos} CFDIs`);

  } catch (err) {
    console.error(`[${solicitudId}] Error:`, err);
    await supabase.from("sat_solicitudes")
      .update({ estado: "error", completado_at: new Date() })
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

  const rfcEmisor   = attr("cfdi:Emisor",   "Rfc") || attr("Emisor",   "Rfc");
  const rfcReceptor = attr("cfdi:Receptor", "Rfc") || attr("Receptor", "Rfc");
  const tipoRaw = attr("cfdi:Comprobante", "TipoDeComprobante") || "I";
  const tipoMap = { I: "ingreso", E: "egreso", T: "traslado", P: "pago", N: "nomina" };
  const total      = parseFloat(attr("cfdi:Comprobante", "Total")    || "0");
  const subtotal   = parseFloat(attr("cfdi:Comprobante", "SubTotal") || "0");
  const moneda     = attr("cfdi:Comprobante", "Moneda")    || "MXN";
  const tipoCambio = parseFloat(attr("cfdi:Comprobante", "TipoCambio") || "1");

  return {
    uuid_fiscal:      uuid.toUpperCase(),
    empresa_id:       empresaId,
    tipo:             tipoMap[tipoRaw] || tipoRaw.toLowerCase(),
    direccion:        rfcEmisor === rfcEmpresa ? "emitido" : "recibido",
    rfc_emisor:       rfcEmisor,
    nombre_emisor:    attr("cfdi:Emisor",   "Nombre"),
    rfc_receptor:     rfcReceptor,
    nombre_receptor:  attr("cfdi:Receptor", "Nombre"),
    uso_cfdi:         attr("cfdi:Receptor", "UsoCFDI"),
    total,
    subtotal,
    moneda,
    tipo_cambio:      tipoCambio,
    total_mxn:        moneda === "MXN" ? total : total * tipoCambio,
    metodo_pago:      attr("cfdi:Comprobante", "MetodoPago"),
    forma_pago:       attr("cfdi:Comprobante", "FormaPago"),
    serie:            attr("cfdi:Comprobante", "Serie"),
    folio:            attr("cfdi:Comprobante", "Folio"),
    fecha_emision:    attr("cfdi:Comprobante", "Fecha"),
    fecha_timbrado:   attr("tfd:TimbreFiscalDigital", "FechaTimbrado"),
    estado_sat:       "vigente",
    xml_raw:          xmlString,
    fecha_importacion: new Date().toISOString(),
  };
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`quantifi-sat-service corriendo en puerto ${process.env.PORT || 3000}`);
});
