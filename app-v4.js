var lightAiModel=storageGet('light-ai-model','gpt-5.6-luna');
var lightAiAnalysis=storageJson('light-ai-analysis',null);
var lightPendingScaleImage='';
var lightPendingMetrics=null;
var lightAiResume='';

function safeSessionGet(name){try{return sessionStorage.getItem(name)||''}catch{return''}}
function safeSessionSet(name,value){try{sessionStorage.setItem(name,value)}catch{}}
function safeSessionRemove(name){try{sessionStorage.removeItem(name)}catch{}}
function escapeText(value){return String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]))}
function safeImageData(value){return typeof value==='string'&&/^data:image\/(jpeg|png|webp);base64,/i.test(value)&&value.length<=7000000?value:''}
function getUserAiKey(){return safeSessionGet('light-openai-key')||storageGet('light-openai-key','')}
function hasUserAiKey(){const value=getUserAiKey();return value.length<=300&&/^sk-[A-Za-z0-9_-]{20,}$/.test(value)}
function aiKeyStatusText(){return hasUserAiKey()?'已配置 · 仅保存在本机':'尚未配置'}

function openAiKeySettings(resume=''){
  lightAiResume=resume;
  const configured=hasUserAiKey(),remembered=Boolean(storageGet('light-openai-key',''));
  openSheet('<button class="close" onclick="closeSheet()">×</button><span class="eyebrow">用户自带模型 · BYOK</span><h2>连接你的 AI 模型</h2><p>密钥只保存在这台设备，不写入轻体记数据库。识别时会由服务器临时转发给 OpenAI，并立即丢弃。</p><label class="formrow"><span>OpenAI API Key</span><input id="userAiKey" type="password" autocomplete="off" placeholder="'+(configured?'已配置，留空则不修改':'sk-…')+'"></label><label class="formrow"><span>模型</span><select id="userAiModel"><option value="gpt-5.6-luna" '+(lightAiModel==='gpt-5.6-luna'?'selected':'')+'>Luna · 省成本</option><option value="gpt-5.6-terra" '+(lightAiModel==='gpt-5.6-terra'?'selected':'')+'>Terra · 均衡</option><option value="gpt-5.6-sol" '+(lightAiModel==='gpt-5.6-sol'?'selected':'')+'>Sol · 高质量</option></select></label><label class="key-remember"><input id="rememberAiKey" type="checkbox" '+(remembered?'checked':'')+'><span><strong>记住在这台设备</strong><small>共享设备不建议开启；关闭后仅本次使用期间有效</small></span></label><div class="key-warning">API 调用费用由你的 OpenAI 账户承担。请勿使用他人的密钥。</div><button class="primarybtn" onclick="saveAiKeySettings()">保存并继续</button>'+(configured?'<button class="later danger-text" onclick="clearAiKeySettings()">移除当前密钥</button>':'')+'<a class="api-key-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">前往 OpenAI 创建 API Key ↗</a>')
}

function saveAiKeySettings(){
  const input=document.getElementById('userAiKey'),candidate=input.value.trim(),existing=getUserAiKey(),keyValue=candidate||existing,remember=document.getElementById('rememberAiKey').checked;
  if(keyValue.length>300||!/^sk-[A-Za-z0-9_-]{20,}$/.test(keyValue)){toast('请输入有效的 OpenAI API Key');return}
  lightAiModel=document.getElementById('userAiModel').value;
  storageSet('light-ai-model',lightAiModel);
  if(remember){storageSet('light-openai-key',keyValue);safeSessionRemove('light-openai-key')}else{safeSessionSet('light-openai-key',keyValue);storageRemove('light-openai-key')}
  const resume=lightAiResume;lightAiResume='';closeSheet();toast('AI 模型已连接');
  if(resume==='scan')runScaleRecognition();
  if(resume==='analysis')runAiAnalysis();
  renderAiView();
}

function clearAiKeySettings(){
  storageRemove('light-openai-key');safeSessionRemove('light-openai-key');lightAiResume='';closeSheet();renderAiView();toast('API Key 已从本机移除')
}

function aiApiFetch(path,options={}){
  const keyValue=getUserAiKey();
  if(keyValue.length>300||!/^sk-[A-Za-z0-9_-]{20,}$/.test(keyValue))return Promise.reject(new Error('请先配置你自己的 OpenAI API Key'));
  const headers=new Headers(options.headers||{});headers.set('x-openai-key',keyValue);headers.set('x-openai-model',lightAiModel);
  return apiFetch(path,{...options,headers})
}

async function syncRecord(record){
  setSyncState('pending','正在安全保存');
  try{
    const payload={date:record.date,weight:record.weight,fat:record.fat,bmi:record.bmi,muscle:record.muscle,fasting:record.fasting,metrics:record.metrics};
    const recordResponse=await apiFetch('/api/records',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});if(!recordResponse.ok)throw new Error('record_sync_failed');
    for(const angle of ['front','side','back']){const photo=record.photos?.[angle];if(photo?.startsWith('data:')){const blob=dataUrlBlob(photo),photoResponse=await apiFetch('/api/photos/'+record.date+'/'+angle,{method:'POST',headers:{'content-type':blob.type},body:blob});if(!photoResponse.ok)throw new Error('photo_sync_failed')}}
    setSyncState('',sessionInfo.signedIn?'已同步到个人账户':'已安全备份');return true
  }catch{setSyncState('error','离线保存，联网后同步');return false}
}

async function aiJson(response){
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.message||'AI 请求失败，请稍后重试');
  return payload
}

function compressAiImage(file){
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const image=new Image();image.onerror=reject;image.onload=()=>{const max=1600,scale=Math.min(1,max/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',.86))};image.src=reader.result};reader.readAsDataURL(file)})
}

function photoInputHtml(angle,label){const url=safeImageData(pendingPhotos[angle]);return '<label class="body-photo-input '+(url?'has':'')+'" id="photoInput-'+angle+'"><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onchange="handleBodyPhoto(event,\''+angle+'\')">'+(url?'<img src="'+url+'" alt="'+escapeText(label)+'体型照片">':'<i>＋</i>')+'<span>'+escapeText(label)+'<small>'+(url?'点击更换':'拍照或相册')+'</small></span></label>'}
function detailPhotoHtml(record,angle,label){const url=safeImageData(record.photos?.[angle]);return url?'<div class="detail-photo"><img src="'+url+'" alt="'+escapeText(label)+'体型照片"><span>'+escapeText(label)+'</span></div>':'<div class="detail-photo empty">'+escapeText(label)+'未上传</div>'}

function openRecorder(){
  editingDate=null;pendingPhotos={front:'',side:'',back:''};lightPendingMetrics=null;
  openSheet('<button class="close" onclick="closeSheet()">×</button><span class="eyebrow">'+shortDate(selected)+'</span><h2>记录这一天的身体</h2><p>上传体脂秤截图会真实识别可见指标，保存前仍由你确认。</p><label class="choice primary upload"><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onchange="startScan(event)"><i class="choicesym">▣</i><span><strong>AI 识别体脂秤截图</strong><small>'+aiKeyStatusText()+' · 可修改结果</small></span><b>›</b></label><button class="choice" onclick="showForm(false)"><i class="choicesym">✎</i><span><strong>手动填写</strong><small>只填写体重也可以</small></span><b>›</b></button><button class="key-inline" onclick="openAiKeySettings()">管理我的 AI 模型</button><p class="privacy-note">截图会发送给你选择的模型进行识别，不会保存为公开内容</p>')
}

async function startScan(event){
  const file=event?.target?.files?.[0];if(!file)return;
  openSheet('<div class="scan"><div class="scanbox"><div class="scale"><strong>准备中</strong><span>体脂秤截图</span><i>正在优化画面</i></div><i class="scanline"></i></div><span class="eyebrow">真实 AI 识别</span><h2>正在读取截图…</h2><p>只提取画面中明确显示的数字，不会推算缺失指标。</p></div>');
  try{lightPendingScaleImage=await compressAiImage(file);if(!hasUserAiKey()){openAiKeySettings('scan');return}await runScaleRecognition()}catch{openRecorder();toast('截图读取失败，请重新选择')}
}

async function runScaleRecognition(){
  if(!lightPendingScaleImage){toast('请重新选择截图');return}
  openSheet('<div class="scan"><div class="scanbox"><div class="scale"><strong>识别中</strong><span>体脂秤截图</span><i>'+escapeText(lightAiModel)+'</i></div><i class="scanline"></i></div><span class="eyebrow">真实 AI 识别</span><h2>正在提取身体指标…</h2><p>通常需要 5–20 秒，请不要关闭页面。</p></div>');
  try{
    const payload=await aiJson(await aiApiFetch('/api/ai/scale',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:lightPendingScaleImage})}));
    const result=payload.result||{};
    if(!Number.isFinite(Number(result.weight))){throw new Error('没有识别到体重，请换一张更清晰的完整截图')}
    lightPendingMetrics=result;
    const recognizedDate=/^\d{4}-\d{2}-\d{2}$/.test(result.measurement_date||'')?result.measurement_date:selected;
    showForm(true,{date:recognizedDate,weight:Number(result.weight),fat:result.body_fat==null?undefined:Number(result.body_fat),bmi:result.bmi==null?undefined:Number(result.bmi),muscle:result.muscle_mass==null?undefined:Number(result.muscle_mass),fasting:true,metrics:result});
    toast('已识别 '+(result.metrics?.length||0)+' 项身体指标')
  }catch(error){openSheet('<button class="close" onclick="closeSheet()">×</button><div class="data-empty ai-error"><i>!</i><strong>这次没有识别成功</strong><span>'+escapeText(error.message)+'</span><button class="primarybtn" onclick="runScaleRecognition()">重新识别</button><button class="later" onclick="showForm(false)">改为手动填写</button></div>')}
}

function metricRows(metrics){
  const items=Array.isArray(metrics?.metrics)?metrics.metrics.filter(item=>item&&item.value!==null&&item.value!==''):[];
  if(!items.length)return'';
  return '<div class="recognized-block"><div class="photo-field-title"><strong>识别到的其他指标</strong><span>保存后可在详情查看</span></div><div class="recognized-grid">'+items.map(item=>'<div><span>'+escapeText(item.label)+'</span><strong>'+escapeText(item.value)+' '+escapeText(item.unit)+'</strong></div>').join('')+'</div>'+(metrics.warnings?.length?'<p class="recognition-warning">'+metrics.warnings.map(escapeText).join('；')+'</p>':'')+'</div>'
}

function showForm(recognized,existing=null){
  const record=existing||{},date=record.date||selected;fasting=record.fasting??true;
  lightPendingMetrics=record.metrics||lightPendingMetrics||null;
  openSheet('<button class="close" onclick="closeSheet()">×</button><span class="eyebrow">'+(existing&&!recognized?'编辑已有记录':recognized?'AI 已完成识别':'轻量记录')+'</span><h2>'+(existing&&!recognized?'编辑身体记录':recognized?'确认身体数据':'手动填写')+'</h2><p>'+(recognized?'请逐项核对；AI 可能看错，所有数字都以你的截图为准。':'体重是唯一必填项，其他数据可以稍后补充。')+'</p><label class="formrow"><span>记录日期</span><input id="recordDate" type="date" value="'+escapeText(date)+'"></label><button class="formrow fasting" onclick="toggleFasting()"><div><strong>晨起空腹测量</strong><small>只有晨起空腹数据进入趋势图</small></div><i class="switch '+(fasting?'on':'')+'" id="fastingSwitch"><i></i></i></button><div class="fields"><label class="field"><span>体重 · 必填</span><div><input id="inputWeight" inputmode="decimal" value="'+escapeText(record.weight??'')+'" placeholder="0.0"><b>kg</b></div></label><label class="field"><span>体脂率</span><div><input id="inputFat" inputmode="decimal" value="'+escapeText(record.fat??'')+'" placeholder="—"><b>%</b></div></label><label class="field"><span>BMI</span><div><input id="inputBmi" inputmode="decimal" value="'+escapeText(record.bmi??'')+'" placeholder="—"></div></label><label class="field"><span>肌肉量</span><div><input id="inputMuscle" inputmode="decimal" value="'+escapeText(record.muscle??'')+'" placeholder="—"><b>kg</b></div></label></div>'+metricRows(lightPendingMetrics)+'<div class="photo-field-title"><strong>体型照片</strong><span>正面、侧面、背面 · 选填</span></div><div class="body-photo-inputs">'+photoInputHtml('front','正面')+photoInputHtml('side','侧面')+photoInputHtml('back','背面')+'</div><p class="storage-hint">照片会压缩并私密保存，可用于日期对比与 AI 教练</p><button class="primarybtn" onclick="saveRecord()">'+(existing&&!recognized?'保存修改':'确认保存')+'</button>')
}

async function saveRecord(){
  const date=document.getElementById('recordDate').value,weight=Number(document.getElementById('inputWeight').value),fatValue=document.getElementById('inputFat').value,bmiValue=document.getElementById('inputBmi').value,muscleValue=document.getElementById('inputMuscle').value;
  if(!datePatternClient(date)||!Number.isFinite(weight)||weight<20||weight>400){toast('请填写有效的日期和体重');return}
  const fat=fatValue===''?undefined:Number(fatValue),bmi=bmiValue===''?undefined:Number(bmiValue),muscle=muscleValue===''?undefined:Number(muscleValue);
  if(fat!=null&&(fat<1||fat>70)){toast('请检查体脂率是否正确');return}
  const previousDate=editingDate,hasPhoto=Object.values(pendingPhotos).some(Boolean),record={date,weight,fat,bmi,muscle,fasting,metrics:lightPendingMetrics||undefined,photo:hasPhoto,photos:{...pendingPhotos}};
  records=records.filter(item=>item.date!==date&&item.date!==previousDate);records.push(record);records.sort((a,b)=>a.date.localeCompare(b.date));editingDate=null;lightPendingMetrics=null;selected=date;const dateParts=date.split('-').map(Number);month=new Date(dateParts[0],dateParts[1]-1,1);saveLocal();if(previousDate&&previousDate!==date)apiFetch('/api/records/'+previousDate,{method:'DELETE'}).catch(()=>{});await syncRecord(record);
  openSheet('<div class="success"><i class="check">✓</i><span class="eyebrow">记录已保存</span><h2>数据已经落到日历</h2><p><strong>'+weight.toFixed(1)+'</strong> 已保存，点日历中的日期即可下钻查看全部指标。</p><button class="primarybtn" onclick="openDayDetail(\''+date+'\')">查看记录详情</button><button class="later" onclick="closeSheet()">返回日历</button></div>')
}

function fullMetricHtml(record){
  const extras=Array.isArray(record.metrics?.metrics)?record.metrics.metrics.filter(item=>item&&item.value!==null&&item.value!==''):[];
  const core=[['体重',record.weight.toFixed(1)+' kg'],['体脂率',record.fat!=null?record.fat.toFixed(1)+'%':'—'],['BMI',record.bmi!=null?record.bmi.toFixed(1):'—'],['肌肉量',record.muscle!=null?record.muscle.toFixed(1)+' kg':'—']];
  return core.concat(extras.map(item=>[item.label,String(item.value)+(item.unit?' '+item.unit:'')])).map(item=>'<div class="detail-metric"><span>'+escapeText(item[0])+'</span><strong>'+escapeText(item[1])+'</strong></div>').join('')
}

function openDayDetail(date){
  const record=records.find(item=>item.date===date);if(!record){openEmptyDay(date);return}
  openSheet('<button class="close" onclick="closeSheet()">×</button><div class="detail-hero"><div><span class="eyebrow">'+shortDate(record.date)+'</span><h2>身体记录详情</h2></div><span class="detail-status">'+(record.fasting?'晨起空腹':'其他时段')+'</span></div><div class="detail-metrics">'+fullMetricHtml(record)+'</div><div class="photo-field-title"><strong>体型照片</strong><span>仅自己可见</span></div><div class="detail-photos">'+detailPhotoHtml(record,'front','正面')+detailPhotoHtml(record,'side','侧面')+detailPhotoHtml(record,'back','背面')+'</div><div class="detail-actions"><button onclick="closeSheet()">关闭</button><button class="edit" onclick="editRecord(\''+record.date+'\')">编辑记录</button></div><button class="delete-action" onclick="deleteRecord(\''+record.date+'\')">删除这条记录</button>')
}

function openEmptyDay(date){
  selected=date;renderDay();openSheet('<button class="close" onclick="closeSheet()">×</button><div class="data-empty"><i>＋</i><strong>'+shortDate(date)+' 还没有记录</strong><span>添加体重、体脂秤截图或体型照片。</span><button class="primarybtn" onclick="openRecorder()">记录这一天</button></div>')
}

function renderCalendar(){
  const year=month.getFullYear(),monthIndex=month.getMonth(),first=(new Date(year,monthIndex,1).getDay()+6)%7,total=new Date(year,monthIndex+1,0).getDate();document.getElementById('monthTitle').textContent=year+'年'+(monthIndex+1)+'月';document.getElementById('journalMonth').textContent=year+'年'+(monthIndex+1)+'月 · 身体日志';document.getElementById('greetingText').textContent=greeting();const streakDays=streak();document.getElementById('streakText').textContent=streakDays?'连续 '+streakDays+' 天':'从今天开始';const box=document.getElementById('calendarDays');box.innerHTML='';for(let index=0;index<first;index++)box.insertAdjacentHTML('beforeend','<span></span>');for(let day=1;day<=total;day++){const date=key(year,monthIndex,day),record=records.find(item=>item.date===date),button=document.createElement('button'),hasPhoto=record&&Object.values(record.photos||{}).some(Boolean);button.className='day'+(date===selected?' selected':'')+(record?' has':'');button.setAttribute('aria-label',shortDate(date)+(record?'，体重 '+record.weight.toFixed(1)+' 公斤':'，无记录'));button.dataset.date=date;button.innerHTML='<span class="num">'+day+'</span>'+(hasPhoto?'<i class="camera"></i>':'')+(record?(record.fasting?'<strong>'+record.weight.toFixed(1)+'</strong>':'<i class="dot"></i>'):'');button.onclick=()=>{selected=date;renderCalendar();record?openDayDetail(date):openEmptyDay(date)};box.appendChild(button)}renderDay();const fastingRecords=records.filter(record=>record.fasting).sort((a,b)=>a.date.localeCompare(b.date)),latest=fastingRecords.at(-1),firstRecord=fastingRecords[0];document.getElementById('latestWeight').textContent=latest?latest.weight.toFixed(1):'—';document.getElementById('weightDelta').textContent=latest&&firstRecord&&latest!==firstRecord?signed(latest.weight-firstRecord.weight,1,' kg'):'暂无趋势'
}

function chooseAiSource(source){
  if(source==='record'&&!photoReadyRecords().length){toast('请先记录正面和侧面照片');showView('home');openRecorder();return}
  aiSource=source;if(source==='record'){const record=photoReadyRecords().at(-1);aiRecordDate=record.date;aiPhotos={front:record.photos.front,side:record.photos.side,back:record.photos.back||''}}else aiPhotos={front:'',side:'',back:''};aiState='photos';renderAiView()
}

function angleCard(type,label,filled){
  const value=aiPhotos[type],hasPreview=typeof value==='string'&&value.startsWith('data:');
  return '<label class="angle-card '+(filled?'filled':'')+'" id="angle-'+type+'"><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onchange="previewAiPhoto(event,\''+type+'\')">'+(hasPreview?'<img src="'+value+'" alt="'+escapeText(label)+'体型照片">':'<span class="angle-person">'+(type==='side'?'◖':'♙')+'</span>')+'<small>'+(filled?(aiSource==='record'?'已引用记录照片':'已上传'):'点击上传')+'</small><strong>'+escapeText(label)+'</strong></label>'
}

function renderAiPhotos(){
  const existing=aiSource==='record',choices=photoReadyRecords();
  aiView.innerHTML='<div class="ai-top"><button onclick="aiState=\'source\';renderAiView()">‹ 返回</button><strong>'+(existing?'选择记录照片':'上传体型照片')+'</strong><span></span></div><div class="ai-step">AI 教练 · 2 / 4</div>'+(existing?'<div class="record-picker"><span>选择一次标准体型记录</span><div class="date-chips">'+choices.map(record=>'<button class="'+(record.date===aiRecordDate?'on':'')+'" onclick="selectAiRecord(this,\''+record.date+'\')">'+shortDate(record.date)+'</button>').join('')+'</div></div>':'')+'<div class="angle-grid" style="margin-top:13px">'+angleCard('front','正面',Boolean(aiPhotos.front))+' '+angleCard('side','侧面',Boolean(aiPhotos.side))+' '+angleCard('back','背面 · 可选',Boolean(aiPhotos.back))+'</div><div class="angle-help">自然站立、全身入镜、光线均匀。AI 只做训练用途观察，不估算精确体脂或诊断健康风险。</div><button class="primarybtn" onclick="beginAiAnalysis()">开始真实 AI 分析</button><button class="key-inline" onclick="openAiKeySettings()">'+aiKeyStatusText()+' · 管理模型</button>'
}

function renderAiSource(){
  aiView.innerHTML='<div class="ai-onboard"><div class="ai-step">AI 教练 · 1 / 4</div><div class="ai-welcome"><div class="ai-orb">✦</div><h2>先让我认识你的身体</h2><p>AI 会读取你自愿提供的体型照片与近期记录，再生成克制的一周训练计划。</p></div><button class="ai-model-card '+(hasUserAiKey()?'ready':'')+'" onclick="openAiKeySettings()"><span><strong>我的 AI 模型</strong><small>'+aiKeyStatusText()+' · '+escapeText(lightAiModel)+'</small></span><b>›</b></button><div class="source-grid"><button class="source-card primary" onclick="chooseAiSource(\'record\')"><i>▦</i><span><strong>引用已有记录照片</strong><small>直接选择曾记录过的一天</small></span><b>›</b></button><button class="source-card" onclick="chooseAiSource(\'upload\')"><i>＋</i><span><strong>重新拍摄或上传</strong><small>正面、侧面，背面可选</small></span><b>›</b></button></div><p class="privacy-note">照片会发送给你选择的模型分析；结果仅作一般健身参考，不是医学诊断</p></div>'
}

async function previewAiPhoto(event,type){
  const file=event.target.files[0];if(!file)return;toast('正在处理照片…');
  try{aiPhotos[type]=await compressAiImage(file);renderAiPhotos();toast('照片已添加')}catch{toast('照片读取失败，请重新选择')}
}

function selectAiRecord(button,date){
  document.querySelectorAll('.date-chips button').forEach(item=>item.classList.remove('on'));button.classList.add('on');aiRecordDate=date;const record=compareRecord(date);aiPhotos={front:record?.photos?.front||'',side:record?.photos?.side||'',back:record?.photos?.back||''};renderAiPhotos();toast('已选择 '+shortDate(date)+' 的照片')
}

async function beginAiAnalysis(){
  if(!aiPhotos.front||!aiPhotos.side){toast('请至少提供正面和侧面照片');return}
  if(!hasUserAiKey()){openAiKeySettings('analysis');return}
  await runAiAnalysis()
}

async function runAiAnalysis(){
  if(!aiPhotos.front||!aiPhotos.side){toast('请重新选择照片');return}
  aiState='scanning';renderAiView();
  try{
    const contextRecords=records.slice(-14).map(record=>({date:record.date,weight:record.weight,fat:record.fat,fasting:record.fasting}));
    const payload=await aiJson(await aiApiFetch('/api/ai/body-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceDate:aiSource==='record'?aiRecordDate:null,images:{front:aiPhotos.front,side:aiPhotos.side,back:aiPhotos.back||null},profile,records:contextRecords})}));
    lightAiAnalysis={...payload.result,model:payload.model,sourceDate:aiSource==='record'?aiRecordDate:null,updatedAt:new Date().toISOString()};storageSet('light-ai-analysis',JSON.stringify(lightAiAnalysis));aiState='result';renderAiView()
  }catch(error){aiState='photos';renderAiView();openSheet('<button class="close" onclick="closeSheet()">×</button><div class="data-empty ai-error"><i>!</i><strong>AI 分析没有完成</strong><span>'+escapeText(error.message)+'</span><button class="primarybtn" onclick="closeSheet();beginAiAnalysis()">重新分析</button><button class="later" onclick="openAiKeySettings(\'analysis\')">检查 API Key</button></div>')}
}

function renderAiResult(){
  const result=lightAiAnalysis;if(!result){aiState='source';renderAiSource();return}
  aiView.innerHTML='<div class="result-enter"><div class="ai-top"><button onclick="aiState=\'photos\';renderAiView()">‹ 重新选择</button><strong>真实 AI 训练评估</strong><span></span></div><div class="ai-step">AI 教练 · 4 / 4</div><div class="result-hero"><div class="body-map"></div><small>基于'+(result.sourceDate?shortDate(result.sourceDate)+'记录照':'本次上传照片')+' · 置信度 '+Math.round((result.confidence||0)*100)+'%</small><h2>'+escapeText(result.shape_tendency)+'</h2><p>'+escapeText(result.summary)+'</p><div class="focus-tags">'+(result.observations||[]).map(item=>'<span>'+escapeText(item)+'</span>').join('')+'</div></div><div class="ai-card"><div class="ai-card-head"><div><span>本阶段优先级</span><strong>训练先抓住三件事</strong></div><b>'+escapeText(result.model||lightAiModel)+'</b></div><div class="week-focus">'+(result.priorities||[]).map((item,index)=>'<div class="focus-item"><i>'+(index+1)+'</i><strong>'+escapeText(item.title)+'</strong><span>'+escapeText(item.reason)+'</span></div>').join('')+'</div><div class="result-actions"><button onclick="aiState=\'photos\';renderAiView()">重新分析</button><button class="primary" onclick="confirmAiShape()">查看本周计划</button></div></div><p class="ai-footer">'+escapeText((result.caveats||[]).join('；'))+'</p></div>'
}

function confirmAiShape(){if(!lightAiAnalysis)return;storageSet('light-ai-profile-ready','yes');aiState='plan';renderAiView();toast('本周计划已生成')}

function resetAiProfile(){
  storageRemove('light-ai-profile-ready');storageRemove('light-ai-analysis');lightAiAnalysis=null;aiState='source';renderAiView();apiFetch('/api/ai/profile',{method:'DELETE'}).catch(()=>{});toast('AI 评估已重置')
}

function dynamicExerciseTask(item,index){
  const image={squat:'goblet-squat.jpg',row:'seated-row.jpg',bridge:'glute-bridge.jpg'}[item.id]||'goblet-squat.jpg';
  return '<div class="exercise-task" data-exercise="'+escapeText(item.id)+'"><button class="exercise-thumb" onclick="openDynamicExercise('+index+')"><img src="assets/exercises/'+image+'" alt="'+escapeText(item.name)+'真人动作示范"></button><span class="exercise-copy"><strong>'+escapeText(item.name)+' <b>'+escapeText(item.sets)+'×'+escapeText(item.reps)+'</b></strong><small>'+escapeText(item.target)+'</small><em>'+escapeText(item.cue)+'</em></span><button class="task-check" onclick="toggleTask(this,'+index+')">✓</button></div>'
}

function openDynamicExercise(index){
  const item=lightAiAnalysis?.today_workout?.[index];if(!item)return;
  const image={squat:'goblet-squat.jpg',row:'seated-row.jpg',bridge:'glute-bridge.jpg'}[item.id]||'goblet-squat.jpg';
  openSheet('<button class="close" onclick="closeSheet()">×</button><div class="exercise-detail"><span class="eyebrow">真人动作参考</span><h2>'+escapeText(item.name)+'</h2><div class="exercise-large"><img src="assets/exercises/'+image+'" alt="'+escapeText(item.name)+'真人动作示范"></div><div class="exercise-meta"><span>'+escapeText(item.sets)+' 组 × '+escapeText(item.reps)+'</span><span>'+escapeText(item.target)+'</span></div><div class="cue-list"><div class="cue"><i>1</i><div><strong>主要发力</strong><span>'+escapeText(item.target)+'</span></div></div><div class="cue"><i>2</i><div><strong>动作关键</strong><span>'+escapeText(item.cue)+'</span></div></div></div><div class="warning">避免：'+escapeText(item.avoid)+'</div><button class="primarybtn" onclick="closeSheet()">我知道了，开始训练</button></div>')
}

function renderAiPlan(){
  const result=lightAiAnalysis;if(!result){aiState='source';renderAiSource();return}
  const plan=result.week_plan||[],workout=result.today_workout||[],nutrition=result.nutrition||[];
  aiView.innerHTML='<div class="titlebar"><div><span class="eyebrow">为'+escapeText(result.shape_tendency)+'定制</span><h2>本周计划</h2></div><button class="reanalyze" onclick="resetAiProfile()">重新分析</button></div><div class="plan-summary"><div><strong>第 1 周 · 建立稳定节奏</strong><br><span>'+escapeText(result.summary)+'</span></div><span class="pill">AI 生成</span></div><div class="week-strip">'+plan.map((day,index)=>'<div class="week-day '+(index===0?'on':'')+'"><b>'+escapeText(day.day)+'</b><span>'+escapeText(day.label)+'</span></div>').join('')+'</div><div class="ai-card"><div class="ai-card-head"><div><span id="todoCount">今天 · 0/'+workout.length+' 完成</span><strong>今日健身房 To-do</strong></div><b>约 '+escapeText(plan[0]?.duration_minutes||40)+' 分钟</b></div><div class="exercise-list">'+workout.map(dynamicExerciseTask).join('')+'</div><div class="todo-progress"><i id="todoProgress"></i></div></div><div class="ai-card"><div class="food-note"><i>⌾</i><div><strong>今天的饮食提醒</strong><p>'+nutrition.map(escapeText).join('；')+'</p></div></div></div><p class="ai-footer">'+escapeText((result.caveats||[]).join('；'))+'</p>';restoreTodo()
}

async function loadAiProfile(){
  try{const response=await apiFetch('/api/ai/profile',{cache:'no-store'});if(!response.ok)return;const payload=await response.json();if(payload.profile?.result){lightAiAnalysis={...payload.profile.result,model:payload.profile.model,sourceDate:payload.profile.sourceDate,updatedAt:payload.profile.updatedAt};storageSet('light-ai-analysis',JSON.stringify(lightAiAnalysis));if(storageGet('light-ai-profile-ready')==='yes')aiState='plan';renderAiView()}}catch{}
}

function renderAiView(){
  if(aiState==='plan'&&!lightAiAnalysis)aiState='source';
  if(aiState==='source')renderAiSource();else if(aiState==='photos')renderAiPhotos();else if(aiState==='scanning')renderAiScan();else if(aiState==='result')renderAiResult();else renderAiPlan()
}

function openDataManager(){
  openSheet('<button class="close" onclick="closeSheet()">×</button><span class="eyebrow">你的数据属于你</span><h2>隐私与数据</h2><p>'+(sessionInfo.signedIn?'已连接个人账户，记录同时保存在手机与云端。':'当前使用匿名安全空间；登录后可跨设备恢复。')+'</p><button class="choice primary" onclick="exportData()"><i class="choicesym">↓</i><span><strong>导出完整备份</strong><small>下载包含记录和照片的 JSON 文件</small></span><b>›</b></button><button class="choice" onclick="openAiKeySettings()"><i class="choicesym">✦</i><span><strong>我的 AI 模型</strong><small>'+aiKeyStatusText()+' · '+escapeText(lightAiModel)+'</small></span><b>›</b></button><label class="choice upload"><input type="file" accept="application/json,.json" onchange="importData(event)"><i class="choicesym">↑</i><span><strong>导入备份</strong><small>恢复之前导出的身体记录</small></span><b>›</b></label><button class="choice" onclick="clearAllData()"><i class="choicesym">×</i><span><strong>清空所有记录</strong><small>永久删除本机与云端的数据和照片</small></span><b>›</b></button>')
}

function openProfileSettings(){
  openSheet('<button class="close" onclick="closeSheet()">×</button><span class="eyebrow">让目标更具体</span><h2>个人资料</h2><p>这些信息只用于你的记录和计划。</p><label class="formrow"><span>称呼</span><input id="profileName" value="'+escapeText(profile.name||'')+'" placeholder="怎么称呼你"></label><label class="formrow"><span>身高</span><input id="profileHeight" inputmode="decimal" value="'+escapeText(profile.height||'')+'" placeholder="cm"></label><label class="formrow"><span>目标体重</span><input id="profileTarget" inputmode="decimal" value="'+escapeText(profile.target||'')+'" placeholder="kg"></label><button class="primarybtn" onclick="saveProfile()">保存个人资料</button>')
}

function importData(event){
  const file=event.target.files[0];if(!file)return;const reader=new FileReader();
  reader.onload=async()=>{try{
    const payload=JSON.parse(reader.result),incoming=Array.isArray(payload)?payload:payload.records;if(!Array.isArray(incoming)||incoming.length>2000)throw new Error();
    records=incoming.map(item=>{const date=String(item.date||''),weight=Number(item.weight);if(!datePatternClient(date)||!Number.isFinite(weight)||weight<20||weight>400)throw new Error();const photos={front:safeImageData(item.photos?.front),side:safeImageData(item.photos?.side),back:safeImageData(item.photos?.back)};return{date,weight,fat:Number.isFinite(Number(item.fat))?Number(item.fat):undefined,bmi:Number.isFinite(Number(item.bmi))?Number(item.bmi):undefined,muscle:Number.isFinite(Number(item.muscle))?Number(item.muscle):undefined,fasting:Boolean(item.fasting),metrics:item.metrics&&typeof item.metrics==='object'?item.metrics:undefined,photo:Object.values(photos).some(Boolean),photos}}).sort((a,b)=>a.date.localeCompare(b.date));
    if(payload.profile&&typeof payload.profile==='object')profile={name:String(payload.profile.name||'').slice(0,40),height:Number(payload.profile.height)||'',target:Number(payload.profile.target)||''};
    storageSet('light-profile',JSON.stringify(profile));selected=records.at(-1)?.date||today;saveLocal();updateAccountUi();closeSheet();for(const record of records)await syncRecord(record);toast('备份已成功恢复')
  }catch{toast('备份文件格式不正确')}};reader.readAsText(file)
}

if(lightAiAnalysis){aiState=storageGet('light-ai-profile-ready')==='yes'?'plan':'result'}else{storageRemove('light-ai-profile-ready');aiState='source'}
