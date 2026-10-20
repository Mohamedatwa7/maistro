// Preview: performance page fed by the LIVE sentiment API.
const fs = require('fs');
let h = fs.readFileSync('index.html', 'utf8');
h = h.replace('<body class="locked">', '<body>');
h = h.replace('</head>', '<style>#login{display:none!important}</style></head>');
const boot = `<script>
document.body.classList.remove('locked');
fetch('https://maistro-demo.vercel.app/api/sentiment').then(r=>r.json()).then(d=>{
 SENTI.posts=d.posts||[];
 STATE.pf={plat:'all',days:'all',sent:'all',dept:'all',feat:'all',flagged:false,q:'',sort:'new'};
 location.hash='#/performance';route();
});
</script>`;
fs.writeFileSync('.preview-perf.html', h + boot);
console.log('ok');
