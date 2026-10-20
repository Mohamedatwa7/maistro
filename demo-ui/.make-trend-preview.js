// Preview: trends page fed by the LIVE curated API, first card expanded.
const fs = require('fs');
let h = fs.readFileSync('index.html', 'utf8');
h = h.replace('<body class="locked">', '<body>');
h = h.replace('</head>', '<style>#login{display:none!important}</style></head>');
const boot = `<script>
document.body.classList.remove('locked');
fetch('https://maistro-demo.vercel.app/api/trends').then(r=>r.json()).then(d=>{
 TRENDS.length=0;d.trends.forEach((t,i)=>TRENDS.push(radarToTrend(t,i)));
 LIVE.on=true;LIVE.fetchedAt=d.fetchedAt;
 STATE.open[TRENDS[0].id]=true;
 location.hash='#/trends';route();
});
</script>`;
fs.writeFileSync('.preview-trends.html', h + boot);
console.log('ok');
