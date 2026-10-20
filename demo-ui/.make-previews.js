// Build login-bypassed preview copies for headless screenshots.
const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace('<body class="locked">', '<body>');
html = html.replace('</head>', '<style>#login{display:none!important}</style></head>');
const mk = (name, hash) => {
  const boot = `<script>location.hash='${hash}';document.body.classList.remove('locked');route();</script>`;
  fs.writeFileSync(name, html + boot);
};
mk('.preview-home.html', '#/');
mk('.preview-cal.html', '#/calendar');
mk('.preview-studio.html', '#/studio');
console.log('previews written');
