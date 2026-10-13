#!/usr/bin/env node
/**
 * Buscador de furgonetas pequeñas de segunda mano en Gipuzkoa (coches.net)
 * =========================================================================
 *
 * Busca anuncios de coches.net en Gipuzkoa que coincidan con los modelos
 * tipo "furgoneta pequeña" (Nemo, Berlingo, Kangoo, Bipper, Fiorino,
 * Partner...) por debajo de un precio máximo, y avisa de los anuncios
 * NUEVOS que no habías visto antes (guarda un historial en un archivo
 * local).
 *
 * INSTALACIÓN LOCAL (opcional, para probarlo en tu propio ordenador)
 * ---------------------------------------------------------------
 *   sudo apt install nodejs npm
 *   npm install cheerio
 *
 *   (Necesitas Node.js 18 o superior, porque usa "fetch" incluido en
 *   Node. Compruébalo con: node --version)
 *
 *   Antes de ejecutarlo, define estas variables de entorno (necesitas
 *   crear un bot de Telegram primero; instrucciones en el archivo
 *   "buscador.yml" que acompaña a este script):
 *
 *       export TELEGRAM_BOT_TOKEN="123456:ABC-tu-token-de-botfather"
 *       export TELEGRAM_CHAT_ID="123456789"
 *
 * USO
 * ---
 *   node buscador_furgonetas.js
 *
 *   # Cambiar presupuesto máximo o palabras clave: edita la sección
 *   # "CONFIGURACIÓN" más abajo.
 *
 * EJECUCIÓN GRATUITA EN LA NUBE (GitHub Actions)
 * ------------------------------------------------
 *   Este script está preparado para ejecutarse solo, cada 3 horas, en
 *   GitHub Actions (gratis). Instrucciones completas en el archivo
 *   "buscador.yml" que acompaña a este script, y en el mensaje de chat
 *   donde te lo he entregado.
 *
 * NOTA IMPORTANTE
 * ---------------
 * coches.net puede cambiar el diseño (HTML) de su web en cualquier
 * momento. Si el script deja de encontrar anuncios de golpe, lo más
 * probable es que hayan cambiado algo en la página y el "parseo" (la
 * parte que interpreta el HTML) necesite un ajuste. Avísame si pasa y lo
 * revisamos.
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// ======================= CONFIGURACIÓN =======================

// Palabras clave que buscamos en el título del anuncio (en minúsculas)
// Se buscan como palabra completa (así "sw" no salta con "swift" ni "caravan"
// con "caravana"). Furgonetas pequeñas + rancheras/familiares/estate.
const PALABRAS_CLAVE = [
  // furgonetas pequeñas
  "nemo", "berlingo", "kangoo", "bipper", "fiorino", "partner", "combo",
  // rancheras / familiares
  "grandtour", "grand tour", "combi", "caravan", "touring", "variant", "sw",
  "avant", "break", "estate", "sportwagon", "tourer", "ranchera", "familiar",
];

// Presupuesto máximo en euros
const PRECIO_MAXIMO = 4000;

// Provincia (tal y como aparece en la URL de coches.net)
const PROVINCIA = "guipuzcoa";

// Cuántas páginas de resultados revisar como máximo en cada tramo de precio
const MAX_PAGINAS = 20;

// Archivo donde se guarda qué anuncios ya hemos visto (para no repetir avisos).
// En GitHub Actions este archivo vive dentro del propio repositorio, para
// que se recuerde de una ejecución a la siguiente (ver workflow adjunto).
const ARCHIVO_HISTORIAL = path.join(__dirname, "vistos.json");

// Tramos de precio de coches.net que vamos a consultar (la web organiza
// los resultados en escalones de precio, así que consultamos un par)
// (las páginas son acumulativas: 4000_euros ya incluye todo lo de menos precio)
const TRAMOS_PRECIO = [4000];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

// Configuración de Telegram: se leen de variables de entorno (en GitHub
// Actions, de los "Secrets" del repositorio).
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ===============================================================

const REGEX_PALABRAS = new RegExp(
  "(?<![a-z0-9áéíóúñ])(" +
    PALABRAS_CLAVE.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")(?![a-z0-9áéíóúñ])",
  "i"
);

function coincidePalabraClave(texto) {
  return REGEX_PALABRAS.test(texto);
}

function cargarHistorial() {
  try {
    const contenido = fs.readFileSync(ARCHIVO_HISTORIAL, "utf-8");
    return new Set(JSON.parse(contenido));
  } catch {
    return new Set();
  }
}

function guardarHistorial(vistos) {
  fs.writeFileSync(
    ARCHIVO_HISTORIAL,
    JSON.stringify([...vistos].sort(), null, 2),
    "utf-8"
  );
}

async function enviarTelegram(mensaje) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(
      "[aviso] faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID; no se envía mensaje."
    );
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const respuesta = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: mensaje,
      disable_web_page_preview: false,
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Telegram respondió ${respuesta.status}: ${detalle}`);
  }
}

/**
 * Extrae pares {url, texto} del HTML de una página de resultados de
 * coches.net. Se apoya en que las URLs de los anuncios de coches.net
 * siguen el patrón '...-en-<provincia>-<numero>-covo.aspx', que es más
 * estable que confiar en nombres de clases CSS (que cambian con más
 * frecuencia que la estructura de las URLs).
 */
function extraerAnuncios(html) {
  const $ = cheerio.load(html);
  const patronUrl = /-en-[a-z_]+-\d+-covo\.aspx/i;
  const anuncios = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (patronUrl.test(href)) {
      const urlCompleta = href.startsWith("http")
        ? href
        : `https://www.coches.net${href}`;
      // Subimos hasta el contenedor (article/li/div) para capturar más
      // contexto (título, precio) alrededor del enlace.
      const contenedor = $(el).closest("article, li, div");
      const texto = (contenedor.length ? contenedor.text() : $(el).text())
        .replace(/\s+/g, " ")
        .trim();
      anuncios.push({ url: urlCompleta, texto });
    }
  });

  return anuncios;
}

function precioDentroDePresupuesto(texto, presupuesto) {
  const precios = [...texto.matchAll(/(\d{1,3}(?:\.\d{3})*)\s*€/g)];
  if (precios.length === 0) {
    // Si no encontramos precio en el texto, no descartamos el anuncio:
    // mejor mostrarlo de más que perdérnoslo.
    return true;
  }
  return precios.some((match) => {
    const valor = parseInt(match[1].replace(/\./g, ""), 10);
    return valor <= presupuesto;
  });
}

async function buscarFurgonetas() {
  const vistos = cargarHistorial();
  const nuevosEncontrados = [];

  for (const tramo of TRAMOS_PRECIO) {
    if (tramo > PRECIO_MAXIMO) continue;

    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const sufijoPagina = pagina > 1 ? `?pg=${pagina}` : "";
      const url = `https://www.coches.net/segunda-mano/${PROVINCIA}/${tramo}_euros/${sufijoPagina}`;

      let html;
      try {
        const respuesta = await fetch(url, { headers: HEADERS });
        if (!respuesta.ok) {
          console.warn(`[aviso] respuesta no válida de ${url}: ${respuesta.status}`);
          continue;
        }
        html = await respuesta.text();
      } catch (error) {
        console.warn(`[aviso] no se pudo cargar ${url}: ${error.message}`);
        continue;
      }

      const anuncios = extraerAnuncios(html);
      if (anuncios.length === 0) {
        // Si una página no devuelve nada, probablemente no hay más
        // resultados en ese tramo; no seguimos paginando en vano.
        break;
      }

      for (const { url: urlAnuncio, texto } of anuncios) {
        const textoMin = texto.toLowerCase();

        if (!coincidePalabraClave(textoMin)) continue;

        if (!precioDentroDePresupuesto(texto, PRECIO_MAXIMO)) continue;

        if (vistos.has(urlAnuncio)) continue;

        vistos.add(urlAnuncio);
        nuevosEncontrados.push({ url: urlAnuncio, resumen: texto.slice(0, 160) });
      }
    }
  }

  guardarHistorial(vistos);
  return nuevosEncontrados;
}

// Telegram admite máximo 4096 caracteres por mensaje: agrupamos en trozos.
function trocear(bloques, limite = 3500) {
  const trozos = [];
  let actual = "";
  for (const b of bloques) {
    if (actual && (actual + "\n\n" + b).length > limite) {
      trozos.push(actual);
      actual = b;
    } else {
      actual = actual ? actual + "\n\n" + b : b;
    }
  }
  if (actual) trozos.push(actual);
  return trozos;
}

async function main() {
  console.log("Buscando furgonetas nuevas en coches.net...");
  const nuevos = await buscarFurgonetas();

  if (nuevos.length === 0) {
    console.log("No hay anuncios nuevos que coincidan con tu búsqueda.");
    // Aun así escribimos "encontrados=false" para que el workflow de
    // GitHub Actions sepa que no hace falta hacer commit del historial.
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "encontrados=false\n");
    }
    return;
  }

  console.log(`\n¡${nuevos.length} anuncio(s) nuevo(s) encontrado(s)!\n`);
  const lineas = [];
  for (const { url, resumen } of nuevos) {
    console.log(`- ${resumen}`);
    console.log(`  ${url}\n`);
    lineas.push(`- ${resumen}\n  ${url}`);
  }

  try {
    const cabecera = `¡${nuevos.length} coche(s) nuevo(s) en coches.net!`;
    for (const trozo of trocear([cabecera, ...lineas])) {
      await enviarTelegram(trozo);
    }
    console.log("Mensaje(s) de Telegram enviado(s).");
  } catch (error) {
    console.error("[error] no se pudo enviar el mensaje de Telegram:", error.message);
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "encontrados=true\n");
  }
}

if (require.main === module) {
  main();
}

module.exports = { extraerAnuncios, coincidePalabraClave, precioDentroDePresupuesto, trocear };
