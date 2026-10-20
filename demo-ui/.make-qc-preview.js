// Preview: F1X8 QC console with one completed report.
const fs = require('fs');
let h = fs.readFileSync('index.html', 'utf8');
h = h.replace('<body class="locked">', '<body>');
h = h.replace('</head>', '<style>#login{display:none!important}</style></head>');
const boot = `<script>
document.body.classList.remove('locked');
PROJECTS.unshift({id:'gen-prev',generated:true,studio:true,stage:6,title:'Deadpan Reveal',
 trend:'Setup line then deadpan punchline caption reveal',product:'Bespoke AI Fridge',
 markets:['UAE','KSA'],platforms:['tiktok'],th:['#1a1410','#4a3826'],
 src:{name:'preview'},map:{product:'Bespoke AI Fridge',msg:'The punchline chills here',angle:'Deadpan reveal'},
 thumb:{imageUrl:'https://d3u0tzju9qaucj.cloudfront.net/9bb1fc65-397b-48aa-8a7f-68f454ceb695/335bd254-32b8-4081-85d3-e30cf88f3cfd.png',prompt:'x',note:'x'},
 qc:{real:true,avg:7.4,at:'Just now',runs:{thumb:{score:7.4,funnel_stage:'upper',product_tier:'premium',context_score:8.2,
  kpis:{attention_capture:{score:7.8,label:'strong',methodology:'CV saliency blend'},message_clarity:{score:7.1,label:'good',methodology:'LLM judgment'},
   emotional_pull:{score:6.9,label:'moderate',methodology:'LLM judgment'},brand_strength:{score:7.6,label:'strong',methodology:'logo + palette detection'},
   distinctiveness:{score:7.5,label:'strong',methodology:'cohort embedding distance'}},
  verdict:{summary:'A confident deadpan hero shot with strong brand palette discipline; the reserved title space is the main engagement lever.',
   strengths:['Clean focal hierarchy on the fridge','Brand blues used intentionally','Reads at a glance at phone size'],
   risks:[{rank:1,issue:'Punchline area low contrast',evidence:'Title zone luminance within 12% of backdrop',impact:'Weakens the reveal moment',suggested_fix:'Lift title-zone contrast or darken backdrop gradient',score_lever:'attention_capture (weight 0.28)',confidence:'high'},
    {rank:2,issue:'Product scale slightly ambiguous',suggested_fix:'Add a subtle floor shadow anchor',confidence:'medium'}],
   hierarchy_analysis:'Eye lands on the glowing panel, then sweeps right into the reserved negative space.',
   brand_visibility:'Samsung blue throughline present; no logo needed at this funnel stage.',
   benchmark_context:'Sits above the social KV cohort median for attention capture.',
   revision_brief:{objective:'Sharpen the punchline moment',focal_hierarchy:'Fridge first, title space second',
    headline_copy:'Keep setup line under 6 words',color_type:'Raise title-zone contrast 20%',imagery:'Hold the deadpan angle',measurement:'Re-run F1X8 after revision'}}}}}});
STATE.proj='gen-prev';STATE.stageSel=6;
location.hash='#/studio';route();
</script>`;
fs.writeFileSync('.preview-qc.html', h + boot);
console.log('ok');
