// Scoped, repeatable fixes for the reviewed built-in map. DATA and SVG topology stay intact.
export function polishInteractiveDiagram(html) {
  if (html.includes('data-map-polish="20261105"')) return html;
  if(!html.includes('window.researchDiagram =')||!html.includes('function setupInteractions()'))return html;
  html=html.replace(/\r\n?/g,'\n');
  function once(before, after) {
    if (html.split(before).length !== 2) throw new Error('Interactive map changed near '+before.slice(0,70)+'; review the UI patch before packaging.');
    html = html.replace(before, after);
  }
  once('</style>', `
/* data-map-polish="20261105" */
.flowchart .node,.flowchart .node:focus,.flowchart .node:focus-visible{outline:none!important}
.flowchart .node:focus-visible>.label-container,.flowchart .node.active>.label-container{stroke:#ededed;stroke-width:2px;vector-effect:non-scaling-stroke}
.flowchart .flowchart-link{transition:opacity .12s;stroke-linejoin:miter;stroke-linecap:butt}
#popup{border:1px solid #515862;background:#262a2f;box-shadow:0 12px 30px #0006;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;overflow-wrap:anywhere}
#popup.open{background:#262a2f}
#popup small{display:block}
#popup .connection-jump{display:block;width:100%;margin:6px 0;padding:9px 11px;border:1px solid #505962;border-radius:7px;background:#30373d;color:#d9e8f6;font:inherit;text-align:left;cursor:pointer}
#popup .connection-jump:hover{background:#3a454e;border-color:#8ca5ba}
#popup .connection-jump:focus-visible{outline:2px solid #e2e2e2;outline-offset:2px}
@media(prefers-reduced-motion:reduce){.flowchart .flowchart-link{transition:none}}
</style>`);
  once('  let selected = null;', '  let selected = null;\n  let pinned = false;\n  let hoverTimer = null;\n  let leaveTimer = null;');
  once("    world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;", "    world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;\n    if(selected) place(selected);");
  once('    if (!selected) return;\n    const node = selected;', '    clearTimeout(hoverTimer); clearTimeout(leaveTimer);\n    pinned = false;\n    if (!selected) return;\n    const node = selected;');
  once("    popup.classList.remove('open');", "    popup.classList.remove('open');\n    highlightConnections(null);");
  const oldPlace = /  function place\(node\) \{[\s\S]*?\n  \}\n\n  function open\(id\) \{/;
  if (!oldPlace.test(html)) throw new Error('Map popup placement changed.');
  html = html.replace(oldPlace, `  function place(node) {
    const bounds = node.getBoundingClientRect();
    const margin = 12, gap = 18;
    const coarse = innerWidth <= 600 || matchMedia('(pointer: coarse)').matches;
    const minTop = Math.max(74, viewControl.getBoundingClientRect().bottom + 12);
    const bottom = innerHeight - (coarse ? 76 : 12);
    const leftSpace = Math.max(0, bounds.left - gap - margin);
    const rightSpace = Math.max(0, innerWidth - margin - bounds.right - gap);
    const minSide = Math.min(340, innerWidth - 24);
    let width = Math.min(560, innerWidth - 24), left, top, height;
    if(!coarse && Math.max(leftSpace,rightSpace) >= minSide) {
      const right = rightSpace >= leftSpace;
      width = Math.min(width, right ? rightSpace : leftSpace);
      left = right ? bounds.right + gap : bounds.left - gap - width;
      height = Math.min(720, Math.max(80,bottom-minTop));
      popup.style.width = width + 'px'; popup.style.maxHeight = height + 'px';
      top = Math.max(minTop,Math.min(bounds.top,bottom-popup.offsetHeight));
    } else {
      left = Math.max(margin,Math.min(innerWidth-margin-width,bounds.left));
      const below = Math.max(0,bottom-bounds.bottom-gap);
      const above = Math.max(0,bounds.top-gap-minTop);
      const useBelow = below >= above;
      height = Math.max(80,Math.min(720,useBelow ? below : above));
      popup.style.width = width + 'px'; popup.style.maxHeight = height + 'px';
      top = useBelow ? Math.max(minTop,bounds.bottom+gap) : Math.max(minTop,bounds.top-gap-popup.offsetHeight);
      top = Math.max(minTop,Math.min(top,bottom-popup.offsetHeight));
    }
    popup.style.left = Math.max(margin,left) + 'px';
    popup.style.top = top + 'px';
  }

  function highlightConnections(id) {
    for(const edge of world.querySelectorAll('.flowchart-link')) {
      const relevant = !id || edge.dataset.from === id || edge.dataset.to === id;
      edge.style.opacity = !id ? '.85' : relevant ? '1' : '.16';
      edge.style.strokeWidth = id && relevant ? (1.35/scale)+'px' : '';
    }
  }

  function decorateConnections(svg) {
    const colors={flow:'#8ca5b6',proposal:'#bba366',loop:'#75bda7',failure:'#d99081',audit:'#b399db'};
    for(const path of svg.querySelectorAll('.flowchart-link')) {
      const match=path.id.match(/L_([A-Z][0-9]{2})_([A-Z][0-9]{2})_/);
      if(!match)continue;
      const edge=DATA.edges.find(e=>e.from===match[1]&&e.to===match[2]);
      path.dataset.from=match[1];path.dataset.to=match[2];path.dataset.kind=edge?.kind||'flow';
      path.style.stroke=colors[path.dataset.kind]||colors.flow;
      const title=document.createElementNS('http://www.w3.org/2000/svg','title');
      title.textContent=match[1]+' → '+match[2]+': '+(edge?.label||edge?.kind||'connection');path.append(title);
    }
    highlightConnections(null);
  }

  function open(id, options = {}) {`);
  once('    if (!node || selected === node) return;\n    close();', '    if (!node) return;\n    if(selected === node){if(options.pin !== false)pinned=true;return;}\n    close();');
  once('    selected = node;', '    selected = node;\n    pinned = options.pin !== false;');
  once('    place(node);\n  }', '    place(node);\n    highlightConnections(id);\n  }');
  once("    edgePaths = svg.querySelector('.edgePaths');", "    decorateConnections(svg);\n    edgePaths = svg.querySelector('.edgePaths');");
  once("    if (node && node !== selected) open(node.dataset.nodeId);\n    else close();", "    if(node){if(node===selected && pinned)close();else open(node.dataset.nodeId,{pin:true});}\n    else close();");
  once("  popup.addEventListener('click', event => {", `  canvas.addEventListener('pointerover', event => {
    if(event.pointerType==='touch'||event.buttons||pinned||canvas.style.cursor==='crosshair')return;
    const node=event.target.closest('[data-node-id]');if(!node)return;
    if(node.contains(event.relatedTarget))return;
    clearTimeout(leaveTimer);clearTimeout(hoverTimer);
    hoverTimer=setTimeout(()=>{if(!pinned&&!drag)open(node.dataset.nodeId,{pin:false});},180);
  });
  canvas.addEventListener('pointerout', event => {
    const node=event.target.closest('[data-node-id]');if(!node||node.contains(event.relatedTarget))return;
    clearTimeout(hoverTimer);clearTimeout(leaveTimer);
    if(!pinned)leaveTimer=setTimeout(()=>close(),250);
  });
  popup.addEventListener('pointerenter',()=>clearTimeout(leaveTimer));
  popup.addEventListener('pointerleave',()=>{if(!pinned)leaveTimer=setTimeout(()=>close(),250);});
  popup.addEventListener('click', event => {
    const jump=event.target.closest('[data-jump-node]');
    if(jump){
      const id=jump.dataset.jumpNode;
      if(!world.querySelector('[data-node-id="'+id+'"]'))setView('all');
      focusNode(id);open(id);return;
    }`);
  const connections = " s+=section('Connections',list([...n.incoming.map(e=>'IN: '+e.from+' → '+n.id+' — '+(e.label||e.kind)),...n.outgoing.map(e=>'OUT: '+n.id+' → '+e.to+' — '+(e.label||e.kind))]));";
  once(connections, " s+=section('Connections',[...n.incoming.map(e=>({id:e.from,text:'IN: '+e.from+' → '+n.id+' · '+(e.label||e.kind)})),...n.outgoing.map(e=>({id:e.to,text:'OUT: '+n.id+' → '+e.to+' · '+(e.label||e.kind)}))].map(e=>'<button type=\"button\" class=\"connection-jump\" data-jump-node=\"'+esc(e.id)+'\" title=\"Open '+esc(e.id)+' details\">'+esc(e.text)+'</button>').join(''));");
  once('      pinned: Boolean(selected),','      pinned,');
  once('    x = innerWidth * .32 - center.x * scale;', '    x = innerWidth * (innerWidth <= 600 ? .5 : .32) - center.x * scale;');
  return html;
}
