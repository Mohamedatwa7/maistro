// Preview: what the user sees the instant they click "Build in Studio — Copilot"
// on a trend card (draft pipeline + copilot asking for direction).
const fs = require('fs');
let h = fs.readFileSync('index.html', 'utf8');
h = h.replace('<body class="locked">', '<body>');
h = h.replace('</head>', '<style>#login{display:none!important}</style></head>');
const boot = `<script>
document.body.classList.remove('locked');
TRENDS.push({id:'t1',name:'Setup line then deadpan punchline caption reveal',type:'format',markets:['UAE','KSA'],platform:'tiktok',vel:34,status:'rising',desc:'Deadpan meme format',clips:[]});
route();
cpFromTrend('t1');
</script>`;
fs.writeFileSync('.preview-cp.html', h + boot);
console.log('ok');
