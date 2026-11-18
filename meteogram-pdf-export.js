// Self-contained PDF export: no network service, print dialog, or third-party CDN.
// Charts are embedded as high-resolution images to preserve SVG/emoji appearance.
const encoder = new TextEncoder();
const bytes = (s) => encoder.encode(s);

export function buildLandscapeImagePdf(images) {
  if (!images.length) throw new Error('No meteogram pages to export.');
  const chunks = [bytes('%PDF-1.4\n% meteogram\n')];
  const offsets = [0];
  let length = chunks[0].length;
  const append = (data) => { chunks.push(data); length += data.length; };
  const object = (id, parts) => {
    offsets[id] = length;
    append(bytes(`${id} 0 obj\n`));
    for (const part of parts) append(typeof part === 'string' ? bytes(part) : part);
    append(bytes('\nendobj\n'));
  };
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, [`<< /Type /Pages /Count ${images.length} /Kids [${images.map((_, i) => `${3+i*3} 0 R`).join(' ')}] >>`]);
  images.forEach(({jpeg, width, height}, i) => {
    if (!(jpeg instanceof Uint8Array) || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new Error('Invalid PDF page image.');
    const id = 3+i*3;
    object(id, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /XObject << /Im0 ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`]);
    object(id+1, [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
    const content = 'q\n792 0 0 612 0 0 cm\n/Im0 Do\nQ\n';
    object(id+2, [`<< /Length ${bytes(content).length} >>\nstream\n${content}endstream`]);
  });
  const xref = length;
  append(bytes(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Blob(chunks, {type:'application/pdf'});
}

const STYLE_PROPERTIES = ['fill','fill-opacity','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-linecap','stroke-linejoin','opacity','font-family','font-size','font-weight','font-style','letter-spacing','text-anchor','dominant-baseline','paint-order','visibility','display','color','vector-effect','filter','text-decoration'];
export function inlineSvgStyles(svg, view) {
  const clone = svg.cloneNode(true);
  const originals = [svg, ...svg.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((node, i) => {
    const style = view.getComputedStyle(node);
    for (const property of STYLE_PROPERTIES) copies[i].style.setProperty(property, style.getPropertyValue(property));
    // A white text outline can erase small black glyphs in native PDF renderers.
    if (/^(text|tspan)$/i.test(node.tagName)) {
      copies[i].style.setProperty('stroke','none');
      copies[i].style.setProperty('stroke-width','0');
    }
  });
  const box = svg.viewBox.baseVal;
  if (!(box.width > 0 && box.height > 0)) throw new Error('Chart dimensions are unavailable.');
  clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
  clone.setAttribute('width',String(box.width));
  clone.setAttribute('height',String(box.height));
  // Embedded SVG must be self-contained; chart uses no external images/fonts.
  return new view.XMLSerializer().serializeToString(clone);
}

function loadSvgImage(source, view) {
  return new Promise((resolve, reject) => {
    const url = view.URL.createObjectURL(new Blob([source], {type:'image/svg+xml;charset=utf-8'}));
    const image = new view.Image();
    const timer = view.setTimeout(() => finish(new Error('Chart rendering timed out.')), 20000);
    function finish(error) {
      view.clearTimeout(timer); view.URL.revokeObjectURL(url);
      image.onload = null; image.onerror = null;
      error ? reject(error) : resolve(image);
    }
    image.onload = () => finish();
    image.onerror = () => finish(new Error('This browser could not render the chart for PDF. Use browser Print instead.'));
    image.src = url;
  });
}

export function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function createMeteogramPdf(doc, {pixelRatio = 3} = {}) {
  if (!Number.isFinite(pixelRatio) || pixelRatio < 1 || pixelRatio > 4) throw new Error('Invalid PDF resolution.');
  const view = doc.defaultView;
  const pages = Array.from(doc.querySelectorAll('.aviation-meteogram-print-page'));
  if (!pages.length) throw new Error('No meteogram pages to export.');
  await doc.fonts?.ready;
  const images = [];
  // Render sequentially and release each canvas to bound memory on phones.
  for (const page of pages) {
    const canvas = doc.createElement('canvas');
    canvas.width = Math.round(792*pixelRatio); canvas.height = Math.round(612*pixelRatio);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('PDF drawing is unavailable in this browser.');
    ctx.scale(pixelRatio,pixelRatio);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,792,612);
    ctx.fillStyle = '#111'; ctx.textBaseline = 'top';
    let y = 16;
    const line = (text, size=8, bold=false) => {
      ctx.font = `${bold ? 'bold ' : ''}${size}px Arial, sans-serif`;
      for (const part of wrapCanvasText(ctx,text,760)) { ctx.fillText(part,16,y); y += size+3; }
    };
    line(page.querySelector('h1')?.textContent || 'AVIATION METEOGRAM',15,true);
    line(page.querySelector('.aviation-meteogram-print-page-header p')?.textContent || '',9,true);
    line(Array.from(page.querySelectorAll('.aviation-meteogram-print-page-meta > *')).map(n=>n.textContent).join(' · '),8,true);
    for (const selector of ['.aviation-meteogram-print-page-context','.aviation-meteogram-print-coverage','.aviation-meteogram-print-pressure-source','.aviation-meteogram-print-interval-note']) {
      const node = page.querySelector(selector);
      if (node) {
        const value = selector.endsWith('-context') ? Array.from(node.children).map(n=>n.textContent).join(' · ') : node.textContent;
        line(value.replace(/\s+/g,' ').trim(),7);
      }
    }
    y += 5;
    const svg = page.querySelector('.aviation-meteogram-print-chart svg');
    if (svg) {
      const box = svg.viewBox.baseVal;
      const image = await loadSvgImage(inlineSvgStyles(svg,view),view);
      const scale = Math.min(760/box.width,(596-y)/box.height);
      if (!(scale > 0)) throw new Error('Page header is too large for this PDF.');
      ctx.drawImage(image,16,y,box.width*scale,box.height*scale);
    } else line('NO DATA IN THIS INTERVAL',12,true);
    const imageBlob = await new Promise((resolve,reject) => canvas.toBlob(b=>b?resolve(b):reject(new Error('Unable to encode PDF image.')),'image/jpeg',.96));
    images.push({jpeg:new Uint8Array(await imageBlob.arrayBuffer()),width:canvas.width,height:canvas.height});
    canvas.width = 0; canvas.height = 0;
  }
  return buildLandscapeImagePdf(images);
}
