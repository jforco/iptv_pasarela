const fs = require('fs');
const path = require('path');

// ─── CONFIGURACIÓN ─────────────────────────────────────────────
const M3U_URL = 'https://raw.githubusercontent.com/iptv-org/iptv/refs/heads/master/streams/bo.m3u';
const MANUAL_CHANNELS_PATH = path.join(__dirname, '..', 'manual-channels', 'bo.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'canales', 'bo.json');
const VERIFY_TIMEOUT_MS = 4000; 
const BATCH_SIZE = 15;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// ─── FUNCIONES DE VERIFICACIÓN ─────────────────────────────────

/** Verifica flujos M3U8 usando HEAD con fallback a GET parcial (Range) */
async function verificarUrl(url) {
  try {
    let respuesta = await fetch(url, {
      method: 'HEAD',
      headers: HTTP_HEADERS,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    });

    if (respuesta.ok) return true;

    if ([400, 403, 405, 501].includes(respuesta.status)) {
      respuesta = await fetch(url, {
        method: 'GET',
        headers: { ...HTTP_HEADERS, 'Range': 'bytes=0-1024' },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
      });
      return respuesta.ok;
    }

    return false;
  } catch {
    return false;
  }
}

/** Consulta la API de DailyMotion usando los owners extraídos dinámicamente */
async function obtenerCanalesDailyMotion(ownersIds) {
  if (!ownersIds || ownersIds.length === 0) return [];
  
  const ownersParam = ownersIds.join(',');
  const urlApi = `https://api.dailymotion.com/videos?owners=${ownersParam}&fields=id,title,owner,owner.avatar_120_url&flags=live_onair&limit=20`;
  
  try {
    const res = await fetch(urlApi, { headers: HTTP_HEADERS });
    if (!res.ok) return [];
    const datos = await res.json();
    return datos.list || [];
  } catch (error) {
    console.error('⚠ Error al consultar la API de DailyMotion:', error.message);
    return [];
  }
}

function parsearM3U(contenido) {
  const lineas = contenido.split('\n');
  const canales = [];
  let nombreActual = 'Canal Sin Nombre';

  for (const linea of lineas) {
    const trim = linea.trim();
    if (trim.startsWith('#EXTINF:')) {
      nombreActual = trim.split(',').pop().trim() || 'Canal Sin Nombre';
    } else if (trim.startsWith('http')) {
      canales.push({ name: nombreActual, url: trim });
      nombreActual = 'Canal Sin Nombre';
    }
  }
  return canales;
}

// ─── PROCESO PRINCIPAL ─────────────────────────────────────────

async function main() {
  console.log('=== Backend Pasarela Dinámico: Bolivia ===\n');
  const resultadoFinal = {};

  // 1. LEER CONFIGURACIÓN Y SEPARAR FUENTES
  if (!fs.existsSync(MANUAL_CHANNELS_PATH)) {
    throw new Error(`No se encontró el archivo de configuración en: ${MANUAL_CHANNELS_PATH}`);
  }
  
  const canalesManualesRaw = JSON.parse(fs.readFileSync(MANUAL_CHANNELS_PATH, 'utf-8'));
  const listaM3uAVerificar = [];
  const mapaDailyMotion = {}; // Mapeo dinámico: ownerId -> { grupo, nombreSeñal }

  for (const grupo of canalesManualesRaw) {
    for (const sig of grupo.signals) {
      if (sig.url) {
        // Es un streaming M3U8 tradicional
        listaM3uAVerificar.push({ grupo: grupo.name, nombre: sig.name, url: sig.url });
      } else if (sig.dailymotionOwner) {
        // Es un canal de DailyMotion a rastrear
        mapaDailyMotion[sig.dailymotionOwner] = {
          grupo: grupo.name,
          nombreSeñal: sig.name
        };
      }
    }
  }

  // 2. VERIFICAR SEÑALES MANUALES M3U8
  if (listaM3uAVerificar.length > 0) {
    console.log(`Verificando ${listaM3uAVerificar.length} señales de streaming tradicionales...`);
    for (let i = 0; i < listaM3uAVerificar.length; i += BATCH_SIZE) {
      const lote = listaM3uAVerificar.slice(i, i + BATCH_SIZE);
      const resLote = await Promise.all(lote.map(async (c) => ({ ...c, online: await verificarUrl(c.url) })));
      
      for (const r of resLote) {
        if (r.online) {
          if (!resultadoFinal[r.grupo]) resultadoFinal[r.grupo] = [];
          resultadoFinal[r.grupo].push({ name: r.nombre, url: r.url, idVideo: "", logo: "" });
        }
      }
    }
  }

  // 3. PROCESAR DAILYMOTION (EXTRACCIÓN DINÁMICA)
  const ownersDMNecesarios = Object.keys(mapaDailyMotion);
  if (ownersDMNecesarios.length > 0) {
    console.log(`\nConsultando transmisiones activas en DailyMotion para ${ownersDMNecesarios.length} cuentas...`);
    const enVivoDM = await obtenerCanalesDailyMotion(ownersDMNecesarios);
    console.log(`✓ DailyMotion reporta ${enVivoDM.length} señales en vivo en este momento.`);

    for (const live of enVivoDM) {
      const configDinamica = mapaDailyMotion[live.owner];
      if (configDinamica) {
        if (!resultadoFinal[configDinamica.grupo]) resultadoFinal[configDinamica.grupo] = [];
        resultadoFinal[configDinamica.grupo].push({
          name: configDinamica.nombreSeñal,
          url: "",
          idVideo: live.id,
          logo: live['owner.avatar_120_url'] || ""
        });
      }
    }
  }

  // 4. PROCESAR LISTA M3U PÚBLICA (IPTV-ORG)
  console.log('\nDescargando e indexando lista M3U pública (iptv-org)...');
  try {
    const resM3u = await fetch(M3U_URL, { headers: HTTP_HEADERS });
    if (resM3u.ok) {
      const textoM3u = await resM3u.text();
      const canalesM3U = parsearM3U(textoM3u);

      // Obtener set de URLs manuales ya procesadas para evitar duplicidad
      const urlsExistentes = new Set();
      Object.values(resultadoFinal).flat().forEach(s => { if (s.url) urlsExistentes.add(s.url); });

      const m3uFiltrado = canalesM3U.filter(c => !urlsExistentes.has(c.url));
      console.log(`Verificando ${m3uFiltrado.length} canales públicos de iptv-org...`);

      for (let i = 0; i < m3uFiltrado.length; i += BATCH_SIZE) {
        const lote = m3uFiltrado.slice(i, i + BATCH_SIZE);
        const resLote = await Promise.all(lote.map(async (c) => ({ ...c, online: await verificarUrl(c.url) })));
        
        for (const r of resLote) {
          if (r.online) {
            if (!resultadoFinal['Otros Canales']) resultadoFinal['Otros Canales'] = [];
            resultadoFinal['Otros Canales'].push({ name: r.name, url: r.url, idVideo: "", logo: "" });
          }
        }
      }
    }
  } catch (errM3u) {
    console.error('⚠ Error con la lista M3U externa, se generará salida con locales/DM:', errM3u.message);
  }

  // 5. CONSTRUIR ESTRUCTURA DE SALIDA Y GUARDAR
  const jsonSalida = Object.entries(resultadoFinal).map(([groupName, signals]) => ({
    name: groupName,
    signals: signals
  }));

  // Ordenar para dejar "Otros Canales" al fondo de la grilla de la TV
  jsonSalida.sort((a, b) => {
    if (a.name === 'Otros Canales') return 1;
    if (b.name === 'Otros Canales') return -1;
    return 0;
  });

  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(jsonSalida, null, 2));

  console.log(`\n✅ Archivo de producción generado con éxito en: ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('\n❌ Fallo crítico en el script:', err.message);
  process.exit(1);
});