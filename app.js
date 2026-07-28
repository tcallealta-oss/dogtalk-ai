/* DogTalk AI — MVP v0.1.0
   Detección de sonidos caninos (YAMNet/TFJS) + aprendizaje por etiquetado + dashboard. */

const MEANINGS = {
  hambre:      {emoji:'🍖', label:'Tiene hambre'},
  salir:       {emoji:'🚪', label:'Quiere salir'},
  jugar:       {emoji:'🎾', label:'Quiere jugar'},
  atencion:    {emoji:'🥺', label:'Busca atención'},
  ansioso:     {emoji:'😰', label:'Está ansioso'},
  asustado:    {emoji:'😨', label:'Está asustado'},
  dolor:       {emoji:'🤕', label:'Dolor o malestar'},
  territorio:  {emoji:'🛡️', label:'Protege territorio'},
  emocionado:  {emoji:'🤩', label:'Está emocionado'},
};
const SOUND_TYPES = {
  ladrido:{emoji:'🐕', label:'Ladrido'},
  gemido: {emoji:'😢', label:'Gemido'},
  aullido:{emoji:'🌙', label:'Aullido'},
  gruñido:{emoji:'😠', label:'Gruñido'},
};
// map YAMNet display_name -> tipo local
const YAMNET_MAP = {
  'Bark':'ladrido','Yip':'ladrido','Bow-wow':'ladrido','Dog':'ladrido',
  'Howl':'aullido','Growling':'gruñido','Whimper (dog)':'gemido','Whimper':'gemido',
};

const App = {
  state: null, model: null, dogClassIdx: {}, // {idx: displayName}
  listening:false, audioCtx:null, stream:null, procNode:null, buf:[],
  lastDetectAt:0,

  /* ---------- persistencia ---------- */
  load(){ try{ this.state = JSON.parse(localStorage.getItem('dogtalk')) }catch(e){}
    if(!this.state) this.state = {pets:[], activePet:0, settings:{notif:true,autoListen:false}, plan:'free', extraPets:0};
    // migración v0.4 → v0.5 (mono-perro → multi-perro)
    if(!this.state.pets){
      this.state.pets = this.state.pet ? [{...this.state.pet, id:'p1',
        events:this.state.events||[], vaccines:this.state.vaccines||[], carnet:this.state.carnet||[],
        lastAbsence:this.state.lastAbsence||null, absence:this.state.absence||null}] : [];
      this.state.activePet=0; this.state.plan=this.state.plan||'free'; this.state.extraPets=this.state.extraPets||0;
      delete this.state.pet; delete this.state.events; delete this.state.vaccines;
      delete this.state.carnet; delete this.state.lastAbsence; delete this.state.absence;
      this.save();
    }
  },
  // ── acceso al perro activo: el resto del código sigue usando state.pet/events/… ──
  get petIdx(){ return Math.min(this.state.activePet||0, Math.max(0,this.state.pets.length-1)); },
  bindActive(){
    const P=this.state.pets[this.petIdx];
    const s=this.state;
    Object.defineProperty(s,'pet',{configurable:true,get:()=>P||null,set:v=>{
      if(!P){ s.pets.push({...v,id:'p'+Date.now(),events:[],vaccines:[],carnet:[]}); s.activePet=s.pets.length-1; this.bindActive(); }
      else Object.assign(P,v);
    }});
    ['events','vaccines','carnet','lastAbsence','absence'].forEach(k=>{
      Object.defineProperty(s,k,{configurable:true,
        get:()=>{ if(!P) return k==='events'||k==='vaccines'||k==='carnet'?[]:null;
                  if((k==='events'||k==='vaccines'||k==='carnet')&&!P[k]) P[k]=[]; return P[k]; },
        set:v=>{ if(P) P[k]=v; }});
    });
  },
  maxPets(){ // 1 gratis · Premium 1 + extras · Familiar 3 + extras
    const base = this.state.plan==='familiar'?3 : this.state.plan==='premium'?1 : 1;
    return base + (this.state.plan==='free'?0:(this.state.extraPets||0));
  },
  togglePetSwitch(){
    const el=document.getElementById('petSwitch'), caret=document.getElementById('switchCaret');
    if(!el.hidden){ el.hidden=true; caret.classList.remove('open'); return; }
    const canAdd=this.state.pets.length < this.maxPets();
    el.innerHTML = this.state.pets.map((p,i)=>`
      <div class="ps-item ${i===this.petIdx?'sel':''}" onclick="App.switchPet(${i})">
        <div class="ps-av">${p.photo?`<img src="${p.photo}">`:'🐶'}</div>
        <div>${p.name}<span class="ps-meta">${[p.breed,p.age?p.age+' años':''].filter(Boolean).join(' · ')||'Sin datos'}</span></div>
        ${i===this.petIdx?'<span style="margin-left:auto">✓</span>':''}
      </div>`).join('') +
      `<div class="ps-add" onclick="App.addPet()">➕ Agregar otra mascota
        ${canAdd?'':'<span class="ps-lock">USD $5/mes</span>'}</div>`;
    el.hidden=false; caret.classList.add('open');
  },
  switchPet(i){
    this.state.activePet=i; this.bindActive(); this.save();
    document.getElementById('petSwitch').hidden=true;
    document.getElementById('switchCaret').classList.remove('open');
    this.vetHistory=[]; const vc=document.getElementById('vetChat'); if(vc) vc.innerHTML='';
    this.renderHome(); this.toast(`Ahora viendo a ${this.state.pet.name} 🐾`);
  },
  addPet(){
    document.getElementById('petSwitch').hidden=true;
    document.getElementById('switchCaret').classList.remove('open');
    if(this.state.pets.length >= this.maxPets()){
      this.toast('Agrega mascotas extra por USD $5/mes 🐕‍🦺');
      this.go('subscription'); return;
    }
    this._newPet=true;
    ['petName','petBreed','petAge','petWeight','petMedical'].forEach(id=>document.getElementById(id).value='');
    document.querySelectorAll('#petSex .chip,#petActivity .chip').forEach(c=>c.classList.remove('sel'));
    document.getElementById('photoPicker').innerHTML='<span>📷</span><p>Agregar foto</p>';
    this._photoData=null;
    this.go('petform');
  },
  changeExtra(d){
    const min=0, used=Math.max(0,this.state.pets.length-(this.state.plan==='familiar'?3:1));
    this.state.extraPets=Math.max(Math.max(min,used), (this.state.extraPets||0)+d);
    this.save(); this.renderPlan();
  },
  renderPlan(){
    const e=this.state.extraPets||0;
    const el=document.getElementById('extraCount'); if(!el) return;
    el.textContent=e;
    const clp=4990+e*4700;
    document.getElementById('planTotal').textContent=`CLP $${clp.toLocaleString('es-CL')}/mes`+(e?` · ${e+1} mascotas`:'');
  },
  subscribe(plan){
    this.state.plan=plan; this.save(); this.renderPlan();
    this.toast(plan==='premium'?'Premium activado (demo) ⭐':'Plan Familiar activado (demo) 👨‍👩‍👧');
    alert('Demo: aquí se integra el pago (Webpay/MercadoPago para CLP, Stripe para USD).\n\nPlan: '+plan+'\nMascotas extra: '+(this.state.extraPets||0)+' × USD $5');
  },
  save(){ localStorage.setItem('dogtalk', JSON.stringify(this.state)); },

  /* ---------- navegación ---------- */
  go(name){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('screen-'+name).classList.add('active');
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.s===name));
    if(name==='home') this.renderHome();
    if(name==='history') this.renderHistory('todos');
    if(name==='stats') this.renderStats();
    if(name==='vet') this.renderVet();
    if(name==='health') this.renderHealth();
    if(name==='subscription') this.renderPlan();
    const ps=document.getElementById('petSwitch');
    if(ps&&name!=='home'){ ps.hidden=true; document.getElementById('switchCaret').classList.remove('open'); }
    window.scrollTo(0,0);
  },
  skipOnboarding(){ this.state.pet ? this.go('home') : this.go('petform'); },

  /* ---------- perfil ---------- */
  savePet(){
    const name = document.getElementById('petName').value.trim();
    if(!name){ this.toast('Ponle nombre a tu mascota 🐶'); return; }
    const sel = id => (document.querySelector(`#${id} .chip.sel`)||{}).dataset?.v || null;
    if(this._newPet){ // crear mascota adicional
      this.state.pets.push({id:'p'+Date.now(), name,
        breed:document.getElementById('petBreed').value.trim(),
        age:document.getElementById('petAge').value, weight:document.getElementById('petWeight').value,
        sex:sel('petSex'), activity:sel('petActivity'), medical:document.getElementById('petMedical').value.trim(),
        photo:this._photoData||null, events:[], vaccines:[], carnet:[]});
      this.state.activePet=this.state.pets.length-1;
      this._newPet=false; this._photoData=null; this.bindActive(); this.save();
      this.toast(`¡${name} agregado! Ahora tienes ${this.state.pets.length} mascotas 🐾`);
      this.go('home'); return;
    }
    this.state.pet = {
      name, breed: document.getElementById('petBreed').value.trim(),
      age: document.getElementById('petAge').value, weight: document.getElementById('petWeight').value,
      sex: sel('petSex'), activity: sel('petActivity'),
      medical: document.getElementById('petMedical').value.trim(),
      photo: this._photoData || (this.state.pet && this.state.pet.photo) || null,
    };
    this.save(); this.toast(`¡Perfil de ${name} guardado! 🎉`); this.go('home');
  },

  /* ---------- home ---------- */
  renderHome(){
    const p = this.state.pet;
    document.getElementById('homePetName').innerHTML =
      (p ? p.name : 'Configura tu mascota') + ' <span class="switch-caret" id="switchCaret">▾</span>';
    const av = document.getElementById('homeAvatar');
    av.innerHTML = p && p.photo ? `<img src="${p.photo}">` : '🐶';
    document.getElementById('switchCaret').style.display = this.state.pets.length>1?'':'none';
    // mood: significado dominante últimas 24h
    const day = Date.now()-864e5;
    const recent = this.state.events.filter(e=>e.ts>day && e.meaning);
    let mood='😊 Tranquilo', sub='Sin eventos confirmados en 24 h';
    if(recent.length){
      const cnt={}; recent.forEach(e=>cnt[e.meaning]=(cnt[e.meaning]||0)+1);
      const top = Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0][0];
      const moodMap={hambre:'😋 Con apetito',salir:'🚪 Inquieto por salir',jugar:'🎾 Juguetón',atencion:'🥺 Demandante',
        ansioso:'😰 Ansioso',asustado:'😨 Asustado',dolor:'🤕 Posible malestar',territorio:'🛡️ Alerta',emocionado:'🤩 Emocionado'};
      mood = moodMap[top]; sub = `Basado en ${recent.length} evento(s) confirmados en 24 h`;
    }
    document.getElementById('moodValue').textContent = mood;
    document.getElementById('moodSub').textContent = sub;
    this.renderDaily();
    this.renderPrediction();
    this.renderAlerts();
    const feed = document.getElementById('recentEvents');
    feed.innerHTML = this.state.events.slice(-5).reverse().map(e=>this.eventHTML(e)).join('') || '<p class="empty">Aún no hay eventos. ¡Registra el primero!</p>';
  },

  renderAlerts(){
    const el = document.getElementById('alertsList'); const ev=this.state.events;
    const day = Date.now()-864e5, week = Date.now()-7*864e5;
    const alerts=[];
    const today = ev.filter(e=>e.ts>day);
    if(today.filter(e=>e.type==='ladrido').length>10) alerts.push(['warn','📣','Exceso de ladridos hoy. Revisa qué lo está gatillando.']);
    if(ev.filter(e=>e.ts>week && e.meaning==='ansioso').length>=3) alerts.push(['warn','😰','Posible ansiedad por separación: 3+ eventos de ansiedad esta semana.']);
    if(ev.filter(e=>e.ts>week && e.meaning==='dolor').length>=1) alerts.push(['danger','🤕','Se registró posible dolor/malestar. Considera consultar al veterinario.']);
    if(ev.filter(e=>{const h=new Date(e.ts).getHours(); return e.ts>week && (h<6);}).length>=3) alerts.push(['warn','🌙','Alteración de sueño: varios eventos de madrugada esta semana.']);
    if(this.state.lastAbsence&&this.state.lastAbsence.anxious&&this.state.lastAbsence.ts>week)
      alerts.push(['warn','🚪',`En tu última salida, ${this.state.pet?this.state.pet.name:'tu perro'} vocalizó a los ${this.state.lastAbsence.firstLat} min (${this.state.lastAbsence.total} eventos). Posible ansiedad por separación.`]);
    const vs=this.vacSummary();
    if(vs.cls==='danger') alerts.push(['danger','💉',`Vacunas: ${vs.text} Ve a 💉 Carnet y vacunas.`]);
    else if(vs.cls==='warn'&&(this.state.vaccines||[]).length) alerts.push(['warn','⏰',`Vacunas: ${vs.text}`]);
    if(!alerts.length) alerts.push(['info','✅','Todo se ve normal. La IA sigue aprendiendo de '+(this.state.pet?this.state.pet.name:'tu perro')+'.']);
    el.innerHTML = alerts.map(([c,i,t])=>`<div class="alert-card ${c}"><span class="ico">${i}</span><span>${t}</span></div>`).join('');
  },

  /* ---------- eventos ---------- */
  eventHTML(e){
    const st=SOUND_TYPES[e.type]||{emoji:'🎵',label:e.type};
    const m = e.meaning ? MEANINGS[e.meaning] : null;
    const d = new Date(e.ts);
    const time = d.toLocaleDateString('es-CL',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'});
    return `<div class="event-item">
      <span class="event-emoji">${m?m.emoji:st.emoji}</span>
      <div class="event-info">
        <p class="event-title">${st.label}${m?' → '+m.label:''}</p>
        <p class="event-meta">${time}${e.pred&&!e.meaning?` · IA sugiere: ${MEANINGS[e.pred].label}`:''}</p>
      </div>
      ${e.conf?`<span class="event-conf">${Math.round(e.conf*100)}%</span>`:''}
      ${!e.meaning?`<button class="tag-btn" onclick="App.openLabelSheet(${e.id})">Etiquetar</button>`:''}
    </div>`;
  },
  renderHistory(filter){
    document.querySelectorAll('#histFilter .chip').forEach(c=>c.classList.toggle('sel', c.dataset.v===filter));
    const list = this.state.events.filter(e=>filter==='todos'||e.type===filter).slice().reverse();
    document.getElementById('historyList').innerHTML = list.map(e=>this.eventHTML(e)).join('') || '<p class="empty">Sin eventos con este filtro.</p>';
  },

  /* ---------- IA: predicción de significado (aprendizaje por perro) ---------- */
  predictMeaning(type, ts){
    const labeled = this.state.events.filter(e=>e.type===type && e.meaning);
    if(!labeled.length){ // heurística inicial por hora
      const h=new Date(ts).getHours();
      const def = h<9?'hambre':h<12?'salir':h<17?'jugar':h<21?'atencion':'territorio';
      return {meaning:def, conf:0.35};
    }
    // pondera por cercanía horaria (ventana gaussiana de 3h)
    const h=new Date(ts).getHours(); const w={};
    labeled.forEach(e=>{
      const eh=new Date(e.ts).getHours();
      let d=Math.abs(h-eh); d=Math.min(d,24-d);
      const weight=Math.exp(-(d*d)/(2*3*3));
      w[e.meaning]=(w[e.meaning]||0)+weight;
    });
    const tot=Object.values(w).reduce((a,b)=>a+b,0);
    const [top,score]=Object.entries(w).sort((a,b)=>b[1]-a[1])[0];
    const conf=Math.min(0.5+ (score/tot)*0.45 + Math.min(labeled.length,20)*0.005, 0.97);
    return {meaning:top, conf};
  },

  addEvent(type, conf){
    const ts=Date.now();
    const pred=this.predictMeaning(type, ts);
    const e={id:ts, ts, type, conf, pred:pred.meaning, predConf:pred.conf, meaning:null};
    this.state.events.push(e);
    // alimentar el traductor en tiempo real si está corriendo
    if(this.translating) this.transDetections.push({type, conf:conf||0.6});
    // registrar en modo ausencia si está activo
    if(this.state.absence&&this.state.absence.active){
      this.state.absence.events.push({ts,type});
      const feed=document.getElementById('absLive');
      if(feed) feed.insertAdjacentHTML('afterbegin', this.eventHTML(e));
    }
    this.save();
    const name=this.state.pet?this.state.pet.name:'Tu perro';
    const msg=`${name} probablemente ${this.meaningPhrase(pred.meaning)} (${Math.round(pred.conf*100)}% de confianza)`;
    this.notify('DogTalk AI 🐾', msg);
    this.toast(`${SOUND_TYPES[type].emoji} ${SOUND_TYPES[type].label} detectado — ${msg}`);
    const feed=document.getElementById('detectFeed');
    if(feed) feed.insertAdjacentHTML('afterbegin', this.eventHTML(e));
    return e;
  },
  meaningPhrase(m){
    return {hambre:'tiene hambre',salir:'quiere salir',jugar:'quiere jugar',atencion:'busca atención',ansioso:'está ansioso',
      asustado:'está asustado',dolor:'siente dolor o malestar',territorio:'está protegiendo territorio',emocionado:'está emocionado'}[m];
  },

  /* ---------- hoja de etiquetado ---------- */
  _labelTarget:null,
  openLabelSheet(eventId){
    this._labelTarget=eventId;
    document.getElementById('sheetTitle').textContent = eventId?'¿Qué significaba?':'Registrar evento manual';
    document.getElementById('sheetSub').textContent = eventId?'Tu confirmación entrena a la IA de tu perro':'¿Qué está expresando tu perro ahora?';
    document.getElementById('sheetBackdrop').hidden=false;
    document.getElementById('labelSheet').hidden=false;
  },
  closeSheet(){ document.getElementById('sheetBackdrop').hidden=true; document.getElementById('labelSheet').hidden=true; },
  applyLabel(meaning){
    if(this._labelTarget){
      const e=this.state.events.find(x=>x.id===this._labelTarget);
      if(e){ e.meaning=meaning; this.save(); this.toast(`¡Gracias! La IA de ${this.state.pet?this.state.pet.name:'tu perro'} aprendió 🧠`); }
    } else {
      const ts=Date.now();
      this.state.events.push({id:ts,ts,type:'ladrido',conf:null,pred:null,meaning}); this.save();
      this.toast(`Evento registrado: ${MEANINGS[meaning].label} ✅`);
    }
    this.closeSheet(); this.renderHome();
    if(document.getElementById('screen-history').classList.contains('active')) this.renderHistory('todos');
  },

  /* ---------- YAMNet ---------- */
  async loadModel(){
    const st=document.getElementById('aiStatus');
    try{
      this.model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', {fromTFHub:true});
      // class map
      try{
        const csv = await (await fetch('https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv')).text();
        csv.split('\n').slice(1).forEach(line=>{
          const parts=line.split(','); if(parts.length<3) return;
          const idx=+parts[0], name=parts.slice(2).join(',').replace(/"/g,'').trim();
          if(YAMNET_MAP[name]) this.dogClassIdx[idx]=name;
        });
      }catch(e){ // fallback índices conocidos
        this.dogClassIdx={70:'Dog',71:'Bark',72:'Yip',73:'Howl',74:'Bow-wow',75:'Growling',76:'Whimper (dog)'};
      }
      st.textContent='🧠 IA lista (YAMNet, 521 clases de sonido)'; st.className='ai-status ok';
    }catch(err){
      console.error(err);
      st.textContent='⚠️ Sin modelo (offline) — modo demo disponible'; st.className='ai-status err';
    }
  },

  /* ---------- escucha en vivo ---------- */
  async toggleListen(){
    if(this.listening){ this.stopListen(); return; }
    try{
      this.stream = await navigator.mediaDevices.getUserMedia({audio:true});
    }catch(e){ this.toast('Permiso de micrófono denegado 🎙️🚫'); return; }
    this.audioCtx = new (window.AudioContext||window.webkitAudioContext)({sampleRate:16000});
    const src=this.audioCtx.createMediaStreamSource(this.stream);
    this.procNode=this.audioCtx.createScriptProcessor(4096,1,1);
    this.buf=[];
    this.procNode.onaudioprocess=(ev)=>{
      this.buf.push(...ev.inputBuffer.getChannelData(0));
      if(this.buf.length>=15600){ const chunk=this.buf.slice(0,15600); this.buf=this.buf.slice(15600); this.classify(chunk); }
    };
    src.connect(this.procNode); this.procNode.connect(this.audioCtx.destination);
    this.listening=true;
    document.getElementById('micBtn').classList.add('rec');
    document.getElementById('pulseRing').classList.add('on');
    document.getElementById('listenStatus').textContent='Escuchando… deja el teléfono cerca de tu perro 🐕';
    if(Notification && Notification.permission==='default') Notification.requestPermission();
  },
  stopListen(){
    if(this.procNode) this.procNode.disconnect();
    if(this.audioCtx) this.audioCtx.close();
    if(this.stream) this.stream.getTracks().forEach(t=>t.stop());
    this.listening=false;
    document.getElementById('micBtn').classList.remove('rec');
    document.getElementById('pulseRing').classList.remove('on');
    document.getElementById('listenStatus').textContent='Detección pausada';
  },
  async classify(samples){
    if(!this.model) return;
    // anti-spam: 3 s normal, 1 s durante traducción (queremos muestrear más)
    if(Date.now()-this.lastDetectAt < (this.translating?1000:3000)) return;
    try{
      const input=tf.tensor1d(Float32Array.from(samples));
      const [scores]=this.model.predict(input);
      const mean=await scores.mean(0).data();
      input.dispose(); scores.dispose();
      let best=null;
      for(const idx in this.dogClassIdx){
        const s=mean[idx];
        if(s>0.25 && (!best||s>best.s)) best={s, name:this.dogClassIdx[idx]};
      }
      if(best){
        this.lastDetectAt=Date.now();
        this.addEvent(YAMNET_MAP[best.name]||'ladrido', best.s);
      }
    }catch(e){ console.error('classify',e); }
  },

  simulateDetection(){
    const types=['ladrido','ladrido','gemido','gruñido','aullido'];
    this.addEvent(types[Math.floor(Math.random()*types.length)], 0.55+Math.random()*0.4);
  },

  /* ══════ VET IA — chat contextual ══════
     Usa raza, edad, peso, historial médico, vacunas y comportamiento reciente.
     Motor de reglas local (sin backend). Preparado para conectar a API real. */
  VET_KB:[
    {k:['jadea','jadeo','respira','agitad','ahogo','resopla'],t:'jadeo',urgent:['encía','lengua azul','colapso','desmay'],
     r:p=>`El jadeo es el principal mecanismo de termorregulación del perro, pero **jadeo excesivo en reposo** puede indicar dolor, estrés, fiebre, problemas cardiorrespiratorios o golpe de calor.
<br><br><b>Revisa ahora:</b> color de encías (deben ser rosadas), si hay tos, si ocurre tras esfuerzo o sin causa, y la temperatura ambiente.
${p.weight&&p.age>=7?`<br><br>⚠️ Por la edad de ${p.name} (${p.age} años), conviene descartar causas cardíacas con auscultación.`:''}
<br><br><b>Acude al veterinario hoy</b> si: las encías están pálidas/azuladas, hay tos persistente, no logra descansar, o el jadeo lleva más de 24 h sin explicación.`},
    {k:['vomit','devuelve','arcada'],t:'vómito',urgent:['sangre','no para','varias veces','decaído','no toma agua'],
     r:p=>`Un vómito aislado sin otros síntomas suele ser leve. Lo preocupante es la **frecuencia y los signos acompañantes**.
<br><br><b>Manejo inicial:</b> retirar comida 8–12 h (nunca el agua), luego reintroducir porciones pequeñas de dieta blanda. En cachorros el ayuno debe ser mucho más corto.
<br><br><b>Urgente</b> si: hay sangre, vomita repetidamente, tiene el abdomen distendido o duro, está decaído, o pudo haber tragado un objeto/tóxico.
${p.age&&p.age<1?`<br><br>⚠️ En cachorros como ${p.name} la deshidratación avanza muy rápido: no esperes más de unas horas.`:''}`},
    {k:['diarrea','deposicion','caca blanda','suelto'],t:'diarrea',urgent:['sangre','negra','días','decaído'],
     r:p=>`La diarrea aguda suele responder a dieta blanda (pollo hervido y arroz) por 2–3 días y buena hidratación.
<br><br><b>Consulta pronto</b> si: dura más de 48 h, hay sangre o color negro alquitranado, vómitos simultáneos, o decaimiento marcado.
<br><br>Considera también parásitos: revisa cuándo fue la última desparasitación de ${p.name} en la sección 💉 Carnet y vacunas.`},
    {k:['no come','no quiere comer','inapeten','sin apetito'],t:'inapetencia',urgent:['días','decaído','agua'],
     r:p=>`La pérdida de apetito es un signo inespecífico pero relevante. Un perro adulto sano tolera saltarse una comida; **más de 24 h sin comer requiere evaluación**, y en cachorros el margen es de horas.
<br><br><b>Revisa:</b> boca y dientes (dolor dental), si bebe agua, si hay fiebre, y cambios recientes de alimento o rutina.
${App.state.events.filter(e=>(e.meaning||e.pred)==='dolor').length?`<br><br>📌 En el historial de ${p.name} hay eventos asociados a posible dolor — menciónalo en la consulta.`:''}`},
    {k:['cojea','cojera','pata','camina mal','no apoya'],t:'cojera',urgent:['no apoya','grita','hinchad','deform'],
     r:p=>`Ante una cojera: **reposo estricto** (sin correr ni saltar) y observación 24–48 h.
<br><br><b>Consulta sin demora</b> si: no apoya la extremidad, hay hinchazón o deformidad, grita al tocarlo, o la cojera persiste más de 2 días.
${p.breed&&/salchicha|dachshund|basset|corgi/i.test(p.breed)?`<br><br>⚠️ Razas condrodistróficas como ${p.breed} tienen predisposición a **enfermedad discal (hernia)**. Si además arrastra las patas traseras o hay debilidad, es una <b>urgencia neurológica</b>: acude de inmediato.`:''}
${p.weight&&p.age>=7?`<br><br>A los ${p.age} años también es frecuente la artrosis; el control de peso y los suplementos articulares ayudan mucho.`:''}`},
    {k:['rasca','pica','alergia','piel','pelo','caspa','roña'],t:'piel',urgent:['herida','pus','sangra'],
     r:p=>`El prurito (picazón) más frecuente proviene de **pulgas, alergia alimentaria o dermatitis atópica**.
<br><br><b>Primeros pasos:</b> confirmar antipulgas al día, revisar zona lumbar y base de la cola (típico de pulgas), y notar si empeora por estación (ambiental) o es constante (alimentaria).
<br><br>Consulta si hay pérdida de pelo, heridas por rascado, mal olor o secreción: puede haber infección secundaria que requiere tratamiento.`},
    {k:['ansi','solo','separacion','destroza','llora cuando'],t:'ansiedad',
     r:p=>{const a=App.state.lastAbsence;
      return `La ansiedad por separación se manifiesta con vocalización, destrucción o eliminación inadecuada **al quedarse solo**.
${a?`<br><br>📊 <b>Tu último registro:</b> ${p.name} vocalizó a los ${a.firstLat??'—'} min de tu salida, con ${a.total} eventos en ${a.durMin} min. ${a.anxious?'Ese patrón <b>es compatible</b> con ansiedad por separación.':'Ese patrón <b>no sugiere</b> ansiedad significativa.'}`:'<br><br>💡 Usa el 🏠 <b>Modo Ausencia</b> para medirlo objetivamente la próxima vez que salgas.'}
<br><br><b>Manejo:</b> salidas graduales (empezar con 1–2 min), desdramatizar despedidas y llegadas, juguetes dispensadores de comida, y ejercicio antes de salir. Los casos moderados/severos se benefician de un plan con etólogo veterinario.`;}},
    {k:['vacuna','vacunar','antirrab','sextuple','refuerzo'],t:'vacunas',
     r:p=>{const v=App.vacSummary();
      return `<b>Esquema habitual en Chile:</b> séxtuple desde las 6–8 semanas con refuerzos cada 21 días hasta las 16 semanas, antirrábica desde los 3–4 meses, y luego <b>refuerzo anual</b> de ambas. La antirrábica es obligatoria por ley.
<br><br>📋 <b>Estado de ${p.name}:</b> ${v.text}
<br><br>Puedes guardar las fotos de su carnet y las fechas en la sección 💉 <b>Carnet y vacunas</b> para no perder ningún refuerzo.`;}},
    {k:['desparasit','parasito','pulga','garrapata','lombri'],t:'parásitos',
     r:p=>`<b>Interna:</b> cada 3 meses en adultos; en cachorros cada 15 días hasta los 3 meses.
<br><br><b>Externa (pulgas/garrapatas):</b> mensual o según el producto (collares y comprimidos duran más).
<br><br>Registra cada aplicación en 💉 Carnet y vacunas → "Registrar tratamiento" y te aviso cuando toque la siguiente.`},
    {k:['peso','gordo','flaco','obes','dieta','comida','aliment'],t:'nutrición',
     r:p=>`La ración depende de peso, edad, condición corporal y actividad. ${p.weight?`Con ${p.weight} kg y actividad ${p.activity||'media'}, `:''}lo importante es evaluar la <b>condición corporal</b>: deberías palpar las costillas sin presionar y ver cintura desde arriba.
<br><br>El sobrepeso reduce la expectativa de vida y agrava problemas articulares. Divide la ración diaria en 2 tomas y evita premios en exceso (no más del 10% de las calorías).
${p.age&&p.age>=7?`<br><br>A los ${p.age} años conviene un alimento senior con soporte articular.`:''}`},
    {k:['diente','boca','aliento','sarro','encia'],t:'dental',
     r:p=>`La enfermedad periodontal afecta a la mayoría de los perros desde los 3 años y puede repercutir en corazón y riñones.
<br><br><b>Señales:</b> mal aliento persistente, sarro visible, encías rojas o sangrantes, dificultad para masticar.
<br><br><b>Prevención:</b> cepillado con pasta dental canina (nunca humana), snacks dentales y limpieza profesional cuando el veterinario lo indique.`},
    {k:['calor','celo','castr','esteriliz','preñ'],t:'reproductivo',
     r:p=>`La esterilización previene tumores mamarios, piometra y problemas prostáticos, y reduce conductas de vagabundeo y marcaje.
<br><br>El momento óptimo varía según tamaño y sexo — en razas grandes suele recomendarse esperar al cierre de las placas de crecimiento. Conversa el mejor timing para ${p.name} con tu veterinario.`},
    {k:['convuls','ataque','temblor','desmay','epilep'],t:'neurológico',urgent:['convuls','desmay'],
     r:p=>`⚠️ <b>Las convulsiones son una urgencia veterinaria.</b>
<br><br><b>Durante el episodio:</b> no le pongas las manos en la boca, retira objetos alrededor, apaga luces y ruidos, y <b>cronometra la duración</b>.
<br><br><b>Acude de inmediato</b> si dura más de 5 minutos o si se repite. Graba un video si puedes: es muy útil para el diagnóstico.`},
  ],
  vetHistory:[],
  vetContext(){
    const p=this.state.pet; if(!p) return null;
    const week=Date.now()-7*864e5;
    const recent=this.state.events.filter(e=>e.ts>=week);
    const {cnt,total}=this.emoDistribution(7);
    const topEmo=Object.entries(cnt).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1])[0];
    return {p, recent:recent.length,
      topEmo: topEmo?this.EMOS[topEmo[0]].label:null,
      tension: total?Math.round((cnt.ansioso+cnt.estresado)/total*100):0,
      pain: recent.filter(e=>(e.meaning||e.pred)==='dolor').length};
  },
  renderVet(){
    const c=this.vetContext();
    const ctxEl=document.getElementById('vetCtx');
    if(!c){ ctxEl.textContent='Crea el perfil de tu mascota para respuestas personalizadas.'; return; }
    const p=c.p;
    ctxEl.innerHTML=`🔎 <b>Contexto cargado:</b> ${p.name}${p.breed?', '+p.breed:''}${p.age?', '+p.age+' años':''}${p.weight?', '+p.weight+' kg':''} · ${c.recent} eventos esta semana${c.topEmo?' · estado dominante: '+c.topEmo:''}${c.tension?' · tensión '+c.tension+'%':''}`;
    if(!this.vetHistory.length){
      this.vetSay('bot',`¡Hola! Soy el asistente veterinario de <b>${p.name}</b> 🩺<br><br>Tengo cargados su raza, edad, peso, historial médico, vacunas y su comportamiento reciente. Pregúntame lo que necesites — por ejemplo síntomas que notaste, dudas de alimentación, vacunas o conducta.`,true);
    }
    const sug=['Lleva dos días jadeando mucho','¿Cuándo toca la próxima vacuna?','Se rasca mucho','¿Cada cuánto desparasitar?','Está comiendo menos'];
    document.getElementById('vetSuggest').innerHTML=sug.map(s=>`<button onclick="App.vetAsk('${s.replace(/'/g,"\\'")}')">${s}</button>`).join('');
  },
  vetSay(who,html,noDisc){
    const chat=document.getElementById('vetChat');
    const urgent=/urgencia|urgente|inmediato/i.test(html)&&who==='bot';
    const disc=(who==='bot'&&!noDisc)?'<span class="disc">⚕️ Orientación informativa generada por IA. No sustituye la consulta veterinaria presencial.</span>':'';
    chat.insertAdjacentHTML('beforeend',`<div class="msg ${who}${urgent?' urgent':''}">${html}${disc}</div>`);
    chat.scrollTop=chat.scrollHeight;
    this.vetHistory.push({who,html});
  },
  vetAsk(preset){
    const input=document.getElementById('vetQ');
    const q=(preset||input.value).trim(); if(!q) return;
    input.value='';
    this.vetSay('me',q.replace(/</g,'&lt;'));
    const chat=document.getElementById('vetChat');
    chat.insertAdjacentHTML('beforeend','<div class="msg bot typing" id="vetTyping"><i></i><i></i><i></i></div>');
    chat.scrollTop=chat.scrollHeight;
    setTimeout(()=>{
      document.getElementById('vetTyping')?.remove();
      this.vetSay('bot', this.vetAnswer(q));
    }, 700+Math.random()*500);
  },
  vetAnswer(q){
    const p=this.state.pet;
    if(!p) return 'Primero crea el perfil de tu mascota para poder darte una respuesta personalizada 🐶';
    const s=q.toLowerCase();
    const hit=this.VET_KB.find(e=>e.k.some(k=>s.includes(k)));
    if(!hit){
      const c=this.vetContext();
      return `No tengo una guía específica para esa consulta, pero puedo orientarte con lo que sé de <b>${p.name}</b>:
<br><br>• ${p.breed||'Raza no registrada'}${p.age?`, ${p.age} años`:''}${p.weight?`, ${p.weight} kg`:''}
<br>• ${c.recent} vocalizaciones esta semana${c.topEmo?`, estado dominante <b>${c.topEmo}</b>`:''}
${c.pain?`<br>• ⚠️ ${c.pain} evento(s) asociados a posible dolor`:''}
${p.medical?`<br>• Antecedentes: ${p.medical}`:''}
<br><br>Cuéntame con más detalle qué observaste (desde cuándo, con qué frecuencia, si hay otros signos) y te oriento mejor. También puedes generar el 📄 <b>reporte mensual</b> desde Estadísticas para llevarlo a la consulta.`;
    }
    let r=hit.r(p).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>'); // markdown → HTML
    if(hit.urgent&&hit.urgent.some(u=>s.includes(u)))
      r=`🚨 <b>Por lo que describes, esto puede ser urgente. Contacta a un veterinario ahora mismo.</b><br><br>`+r;
    return r;
  },

  /* ══════ CARNET Y VACUNAS ══════ */
  VAC_TYPES:{
    sextuple:{emoji:'💉',label:'Séxtuple / Óctuple',months:12},
    antirrabica:{emoji:'🦠',label:'Antirrábica',months:12},
    bordetella:{emoji:'🫁',label:'Bordetella (tos de perreras)',months:12},
    giardia:{emoji:'🧫',label:'Giardia',months:12},
    otra_vac:{emoji:'💊',label:'Otra vacuna',months:12},
  },
  TREAT_TYPES:{
    desp_interna:{emoji:'🪱',label:'Desparasitación interna',months:3},
    desp_externa:{emoji:'🦟',label:'Antipulgas / garrapatas',months:1},
    control:{emoji:'🩺',label:'Control veterinario',months:12},
    otro_trat:{emoji:'📌',label:'Otro tratamiento',months:6},
  },
  vacNextDate(v){
    if(v.next) return new Date(v.next+'T12:00:00').getTime();
    const def=(this.VAC_TYPES[v.type]||this.TREAT_TYPES[v.type]);
    if(!def) return null;
    const d=new Date(v.date+'T12:00:00'); d.setMonth(d.getMonth()+def.months);
    return d.getTime();
  },
  vacState(v){
    const n=this.vacNextDate(v); if(!n) return {cls:'ok',txt:'Registrada'};
    const days=Math.ceil((n-Date.now())/864e5);
    if(days<0) return {cls:'late',txt:`Vencida hace ${Math.abs(days)} d`,days};
    if(days<=30) return {cls:'soon',txt:`En ${days} días`,days};
    return {cls:'ok',txt:`Al día`,days};
  },
  vacSummary(){
    const list=this.state.vaccines||[];
    if(!list.length) return {cls:'warn',text:'aún no hay vacunas registradas.'};
    const states=list.map(v=>({v,s:this.vacState(v)}));
    const late=states.filter(x=>x.s.cls==='late');
    const soon=states.filter(x=>x.s.cls==='soon');
    if(late.length) return {cls:'danger',text:`hay ${late.length} ${late.length===1?'dosis vencida':'dosis vencidas'} (${late.map(x=>this.vacLabel(x.v.type)).join(', ')}).`};
    if(soon.length) return {cls:'warn',text:`${soon.length} ${soon.length===1?'dosis vence':'dosis vencen'} este mes (${soon.map(x=>this.vacLabel(x.v.type)).join(', ')}).`};
    return {cls:'ok',text:'todas las vacunas están al día ✅'};
  },
  vacLabel(t){ return (this.VAC_TYPES[t]||this.TREAT_TYPES[t]||{label:t}).label; },
  renderHealth(){
    const name=this.state.pet?this.state.pet.name:'Tu perro';
    const sum=this.vacSummary();
    document.getElementById('vacStatus').className='vac-status '+sum.cls;
    document.getElementById('vacStatus').innerHTML=
      `<span class="vs-ico">${sum.cls==='ok'?'✅':sum.cls==='warn'?'⏰':'⚠️'}</span><div>Para <b>${name}</b>, ${sum.text}</div>`;
    // carnet
    const cg=document.getElementById('carnetGrid');
    const imgs=this.state.carnet||[];
    cg.innerHTML=imgs.length
      ? imgs.map((src,i)=>`<div class="carnet-thumb" onclick="App.viewCarnet(${i})"><img src="${src}"><button class="del" onclick="event.stopPropagation();App.delCarnet(${i})">✕</button></div>`).join('')
      : '<div class="carnet-empty">📄 Sin fotos del carnet.<br>Súbelas para tenerlas siempre a mano.</div>';
    // listas
    const all=this.state.vaccines||[];
    const render=(arr,el,empty)=>{
      document.getElementById(el).innerHTML=arr.length? arr.sort((a,b)=>b.date.localeCompare(a.date)).map(v=>{
        const s=this.vacState(v), def=this.VAC_TYPES[v.type]||this.TREAT_TYPES[v.type]||{emoji:'💊'};
        const nd=this.vacNextDate(v);
        return `<div class="vac-item"><span class="vi-ico">${def.emoji}</span>
          <div class="vi-info"><p class="vi-name">${this.vacLabel(v.type)}</p>
          <p class="vi-meta">Aplicada ${new Date(v.date+'T12:00:00').toLocaleDateString('es-CL')}${nd?` · próxima ${new Date(nd).toLocaleDateString('es-CL')}`:''}${v.vet?' · '+v.vet:''}</p></div>
          <span class="vac-badge ${s.cls}">${s.txt}</span>
          <button class="vi-del" onclick="App.delVac('${v.id}')">🗑️</button></div>`;
      }).join('') : `<p class="empty">${empty}</p>`;
    };
    render(all.filter(v=>this.VAC_TYPES[v.type]),'vacList','Sin vacunas registradas.');
    render(all.filter(v=>this.TREAT_TYPES[v.type]),'treatList','Sin tratamientos registrados.');
  },
  _vacMode:'vacuna',
  openVacSheet(mode){
    this._vacMode=mode||'vacuna';
    const types=this._vacMode==='tratamiento'?this.TREAT_TYPES:this.VAC_TYPES;
    document.getElementById('vacSheetTitle').textContent=this._vacMode==='tratamiento'?'Registrar tratamiento':'Registrar vacuna';
    document.getElementById('vacType').innerHTML=Object.entries(types).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('');
    document.getElementById('vacDate').value=new Date().toISOString().slice(0,10);
    document.getElementById('vacNext').value=''; document.getElementById('vacVet').value='';
    document.getElementById('vacBackdrop').hidden=false; document.getElementById('vacSheet').hidden=false;
  },
  closeVacSheet(){ document.getElementById('vacBackdrop').hidden=true; document.getElementById('vacSheet').hidden=true; },
  saveVac(){
    const date=document.getElementById('vacDate').value;
    if(!date){ this.toast('Indica la fecha de aplicación 📅'); return; }
    const v={id:'v'+Date.now(), type:document.getElementById('vacType').value, date,
      next:document.getElementById('vacNext').value||null, vet:document.getElementById('vacVet').value.trim()};
    (this.state.vaccines=this.state.vaccines||[]).push(v); this.save();
    this.closeVacSheet(); this.renderHealth();
    const nd=this.vacNextDate(v);
    this.toast(`${this.vacLabel(v.type)} registrada ✅${nd?` · próxima ${new Date(nd).toLocaleDateString('es-CL')}`:''}`);
  },
  delVac(id){
    if(!confirm('¿Eliminar este registro?')) return;
    this.state.vaccines=(this.state.vaccines||[]).filter(v=>v.id!==id); this.save(); this.renderHealth();
  },
  addCarnet(file){
    const r=new FileReader();
    r.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        // comprimir para no reventar localStorage
        const max=1100, sc=Math.min(1,max/Math.max(img.width,img.height));
        const c=document.createElement('canvas');
        c.width=img.width*sc; c.height=img.height*sc;
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        const data=c.toDataURL('image/jpeg',0.72);
        (this.state.carnet=this.state.carnet||[]).push(data);
        try{ this.save(); }
        catch(e){ this.state.carnet.pop(); this.toast('Sin espacio local. Elimina alguna foto antigua 📦'); return; }
        this.renderHealth(); this.toast('Foto del carnet guardada 📄');
      };
      img.src=r.result;
    };
    r.readAsDataURL(file);
  },
  delCarnet(i){
    if(!confirm('¿Eliminar esta foto del carnet?')) return;
    this.state.carnet.splice(i,1); this.save(); this.renderHealth();
  },
  viewCarnet(i){
    const src=this.state.carnet[i];
    const d=document.createElement('div'); d.className='lightbox';
    d.innerHTML=`<button class="lb-close">✕</button><img src="${src}">`;
    d.onclick=()=>d.remove(); document.body.appendChild(d);
  },

  /* ══════ REPORTE MENSUAL PDF ══════
     Genera un documento imprimible (Guardar como PDF) para llevar al veterinario. */
  generateReport(){
    const p=this.state.pet;
    if(!p){ this.toast('Primero crea el perfil de tu mascota 🐶'); return; }
    const days=30, since=Date.now()-days*864e5;
    const evs=this.state.events.filter(e=>e.ts>=since).sort((a,b)=>a.ts-b.ts);
    if(evs.length<3){ this.toast('Necesitas más eventos registrados para un reporte útil 📊'); return; }
    const {cnt}=this.emoDistribution(days);
    const emoTot=Object.values(cnt).reduce((a,b)=>a+b,0)||1;
    const byType={}; evs.forEach(e=>byType[e.type]=(byType[e.type]||0)+1);
    const byMeaning={}; evs.forEach(e=>{const m=e.meaning||e.pred; if(m) byMeaning[m]=(byMeaning[m]||0)+1;});
    const hours=Array(24).fill(0); evs.forEach(e=>hours[new Date(e.ts).getHours()]++);
    const hMax=Math.max(...hours,1);
    const daysTracked=new Set(evs.map(e=>new Date(e.ts).toDateString())).size;
    const night=evs.filter(e=>new Date(e.ts).getHours()<6).length;
    const anxPct=Math.round((cnt.ansioso+cnt.estresado)/emoTot*100);
    // hallazgos clínicos
    const find=[];
    if(anxPct>=35) find.push(['alta',`Estados de tensión (ansioso/estresado) representan el ${anxPct}% del período. Se sugiere evaluación conductual.`]);
    if(byMeaning.dolor) find.push(['alta',`Se registraron ${byMeaning.dolor} evento(s) asociados a posible dolor o malestar.`]);
    if(night>=5) find.push(['media',`${night} vocalizaciones en horario nocturno (00:00–06:00): posible alteración del descanso.`]);
    if(this.state.lastAbsence&&this.state.lastAbsence.anxious) find.push(['media',`Última medición de ausencia: vocalizó a los ${this.state.lastAbsence.firstLat} min de la partida (${this.state.lastAbsence.total} eventos). Compatible con ansiedad por separación.`]);
    if((byType.gemido||0)/evs.length>0.3) find.push(['media',`Alta proporción de gemidos (${Math.round((byType.gemido/evs.length)*100)}%), asociable a búsqueda de atención o incomodidad.`]);
    if(!find.length) find.push(['baja','No se detectaron patrones anómalos relevantes en el período analizado.']);
    const fmt=d=>new Date(d).toLocaleDateString('es-CL',{day:'2-digit',month:'short',year:'numeric'});
    const emoRows=Object.entries(cnt).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1])
      .map(([k,v])=>`<tr><td>${this.EMOS[k].emoji} ${this.EMOS[k].label}</td><td>${v}</td><td>${Math.round(v/emoTot*100)}%</td></tr>`).join('');
    const meanRows=Object.entries(byMeaning).sort((a,b)=>b[1]-a[1])
      .map(([m,v])=>`<tr><td>${MEANINGS[m].emoji} ${MEANINGS[m].label}</td><td>${v}</td><td>${Math.round(v/evs.length*100)}%</td></tr>`).join('');

    const html=`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>Reporte DogTalk AI — ${p.name}</title><style>
@page{margin:16mm}
*{box-sizing:border-box}body{font-family:'Segoe UI',system-ui,sans-serif;color:#2b2320;margin:0;padding:24px;max-width:820px}
header{border-bottom:4px solid #FF6B4A;padding-bottom:14px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-end}
h1{font-size:25px;margin:0}h1 small{display:block;font-size:12px;color:#8b7b73;font-weight:600;margin-top:3px}
.brand{font-size:13px;font-weight:800;color:#FF6B4A;text-align:right}
h2{font-size:15px;margin:22px 0 8px;padding-bottom:5px;border-bottom:2px solid #f0e6dc;color:#FF6B4A}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:6px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #f0e6dc}
th{background:#fdf6ee;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8b7b73}
.grid{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.kpi{flex:1;min-width:110px;background:#fdf6ee;border:1px solid #f0e6dc;border-radius:10px;padding:11px;text-align:center}
.kpi b{display:block;font-size:22px;color:#FF6B4A}.kpi span{font-size:10.5px;color:#8b7b73;font-weight:600}
.f{padding:9px 12px;border-radius:8px;margin-bottom:6px;font-size:12.5px;border-left:4px solid}
.f.alta{background:#ffeeeb;border-color:#FF6B4A}.f.media{background:#fff7e4;border-color:#FFBF3F}.f.baja{background:#e6f7f4;border-color:#2EC4B6}
.chart{display:flex;align-items:flex-end;gap:2px;height:80px;border-bottom:1.5px solid #e5d9cf;margin:8px 0 16px}
.chart i{flex:1;background:linear-gradient(180deg,#FF8FA3,#FF6B4A);border-radius:2px 2px 0 0;position:relative}
.chart i s{position:absolute;bottom:-15px;left:50%;transform:translateX(-50%);font-size:7.5px;color:#8b7b73;text-decoration:none}
footer{margin-top:26px;padding-top:12px;border-top:1px solid #f0e6dc;font-size:10.5px;color:#8b7b73;line-height:1.5}
@media print{.noprint{display:none}}
.noprint{position:fixed;top:14px;right:14px;background:#FF6B4A;color:#fff;border:0;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2)}
</style></head><body>
<button class="noprint" onclick="window.print()">🖨️ Guardar como PDF</button>
<header><h1>Reporte de comportamiento canino<small>Período: ${fmt(since)} — ${fmt(Date.now())} (${days} días)</small></h1>
<div class="brand">🐾 DogTalk AI<br><span style="color:#8b7b73;font-weight:600">Generado ${fmt(Date.now())}</span></div></header>

<h2>Ficha del paciente</h2>
<table><tr><th>Nombre</th><td>${p.name}</td><th>Raza</th><td>${p.breed||'—'}</td></tr>
<tr><th>Edad</th><td>${p.age?p.age+' años':'—'}</td><th>Peso</th><td>${p.weight?p.weight+' kg':'—'}</td></tr>
<tr><th>Sexo</th><td>${p.sex||'—'}</td><th>Actividad</th><td>${p.activity||'—'}</td></tr>
${p.medical?`<tr><th>Historial médico</th><td colspan="3">${p.medical}</td></tr>`:''}</table>

<h2>Resumen del período</h2>
<div class="grid">
<div class="kpi"><b>${evs.length}</b><span>Vocalizaciones</span></div>
<div class="kpi"><b>${daysTracked}</b><span>Días con registro</span></div>
<div class="kpi"><b>${(evs.length/Math.max(1,daysTracked)).toFixed(1)}</b><span>Promedio diario</span></div>
<div class="kpi"><b>${anxPct}%</b><span>Estados de tensión</span></div>
<div class="kpi"><b>${night}</b><span>Eventos nocturnos</span></div></div>

<h2>Hallazgos y observaciones</h2>
${find.map(([lvl,txt])=>`<div class="f ${lvl}"><b>${lvl==='alta'?'⚠️ Atención':lvl==='media'?'📌 Observación':'✅ Normal'}:</b> ${txt}</div>`).join('')}

<h2>Distribución emocional</h2>
<table><tr><th>Estado</th><th>Registros</th><th>Proporción</th></tr>${emoRows}</table>

<h2>Necesidades expresadas</h2>
<table><tr><th>Interpretación</th><th>Registros</th><th>Proporción</th></tr>${meanRows||'<tr><td colspan="3">Sin datos etiquetados</td></tr>'}</table>

<h2>Distribución horaria de vocalizaciones</h2>
<div class="chart">${hours.map((v,i)=>`<i style="height:${Math.max(2,v/hMax*100)}%">${i%3===0?`<s>${i}h</s>`:''}</i>`).join('')}</div>

<h2>Tipos de vocalización</h2>
<table><tr><th>Tipo</th><th>Cantidad</th><th>Proporción</th></tr>
${Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,v])=>`<tr><td>${SOUND_TYPES[t].emoji} ${SOUND_TYPES[t].label}</td><td>${v}</td><td>${Math.round(v/evs.length*100)}%</td></tr>`).join('')}</table>

<footer><b>Metodología:</b> los sonidos se clasifican automáticamente mediante un modelo acústico (YAMNet) y las interpretaciones se construyen con el historial etiquetado por el tutor, ponderado por hora del día.
<br><b>Aviso:</b> este reporte es un apoyo informativo generado por IA a partir de datos del hogar. <b>No constituye diagnóstico veterinario.</b> Ante cualquier signo de dolor, cambio brusco de conducta o malestar, consulte a un médico veterinario.</footer>
</body></html>`;
    const w=window.open('','_blank');
    if(!w){ this.toast('Permite las ventanas emergentes para ver el reporte 🚫'); return; }
    w.document.write(html); w.document.close();
    this.toast('Reporte generado 📄 Usa "Guardar como PDF"');
  },

  /* ══════ PERFIL EMOCIONAL ══════
     Mapea significados → 6 estados emocionales y muestra distribución + evolución. */
  EMOS:{
    feliz:    {emoji:'😄', label:'Feliz',     color:'#FFBF3F', from:['jugar','emocionado']},
    relajado: {emoji:'😌', label:'Relajado',  color:'#2EC4B6', from:['__calma__']},
    aburrido: {emoji:'😑', label:'Aburrido',  color:'#9B5DE5', from:['atencion']},
    protector:{emoji:'🛡️', label:'Protector', color:'#5B8DEF', from:['territorio']},
    ansioso:  {emoji:'😰', label:'Ansioso',   color:'#FF8FA3', from:['ansioso']},
    estresado:{emoji:'😖', label:'Estresado', color:'#FF6B4A', from:['asustado','dolor']},
  },
  emoRangeDays:7,
  emoOf(ev){
    const m=ev.meaning||ev.pred;
    for(const k in this.EMOS) if(this.EMOS[k].from.includes(m)) return k;
    return null; // hambre/salir son necesidades, no emociones
  },
  emoDistribution(days){
    const since=Date.now()-days*864e5;
    const evs=this.state.events.filter(e=>e.ts>=since);
    const cnt={}; Object.keys(this.EMOS).forEach(k=>cnt[k]=0);
    evs.forEach(e=>{ const k=this.emoOf(e); if(k) cnt[k]++; });
    // "relajado" se infiere: días con poca actividad respecto al promedio
    const byDay={};
    evs.forEach(e=>{ const d=new Date(e.ts).toDateString(); byDay[d]=(byDay[d]||0)+1; });
    const daysTracked=Object.keys(byDay).length||1;
    const avg=evs.length/daysTracked;
    let calm=0;
    for(let i=0;i<days;i++){
      const d=new Date(Date.now()-i*864e5).toDateString();
      const n=byDay[d]||0;
      if(n<=Math.max(1,avg*0.4)) calm++; // jornada tranquila
    }
    cnt.relajado=calm;
    const total=Object.values(cnt).reduce((a,b)=>a+b,0);
    return {cnt,total,evs};
  },
  renderEmotional(){
    const donut=document.getElementById('emoDonut'); if(!donut) return;
    const {cnt,total}=this.emoDistribution(this.emoRangeDays);
    const name=this.state.pet?this.state.pet.name:'Tu perro';
    const legend=document.getElementById('emoLegend');
    if(!total){
      donut.style.background='conic-gradient(var(--line) 0 100%)';
      document.getElementById('emoTopEmoji').textContent='🐾';
      document.getElementById('emoTopName').textContent='Sin datos';
      legend.innerHTML='<p class="emo-empty">Registra eventos para construir el perfil emocional.</p>';
      document.getElementById('emoInsight').textContent='';
      document.getElementById('emoEvo').innerHTML='<p class="emo-empty">Aún no hay evolución que mostrar.</p>';
      return;
    }
    const entries=Object.entries(cnt).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
    // donut
    let acc=0; const stops=entries.map(([k,v])=>{
      const s=acc/total*100; acc+=v; const e=acc/total*100;
      return `${this.EMOS[k].color} ${s}% ${e}%`;
    });
    donut.style.background=`conic-gradient(${stops.join(',')})`;
    const [topK]=entries[0];
    document.getElementById('emoTopEmoji').textContent=this.EMOS[topK].emoji;
    document.getElementById('emoTopName').textContent=this.EMOS[topK].label;
    legend.innerHTML=entries.map(([k,v])=>`
      <div class="emo-li"><span class="emo-dot" style="background:${this.EMOS[k].color}"></span>
      ${this.EMOS[k].emoji} ${this.EMOS[k].label}<span class="pc">${Math.round(v/total*100)}%</span></div>`).join('');
    // insight comparando con el período anterior
    const prev=this.emoDistribution(this.emoRangeDays*2);
    const prevOnly={}; Object.keys(cnt).forEach(k=>prevOnly[k]=(prev.cnt[k]||0)-cnt[k]);
    const prevTot=Object.values(prevOnly).reduce((a,b)=>a+Math.max(0,b),0);
    let ins=`${name} estuvo mayormente <b>${this.EMOS[topK].label.toLowerCase()}</b> (${Math.round(entries[0][1]/total*100)}% del período). `;
    if(prevTot>2){
      const nowPct=entries[0][1]/total, prevPct=Math.max(0,prevOnly[topK])/prevTot;
      const delta=Math.round((nowPct-prevPct)*100);
      if(Math.abs(delta)>=8) ins+=`Eso es <b>${delta>0?'+':''}${delta} puntos</b> vs el período anterior. `;
      const neg=(cnt.ansioso+cnt.estresado)/total, negPrev=(Math.max(0,prevOnly.ansioso)+Math.max(0,prevOnly.estresado))/prevTot;
      if(neg-negPrev>0.12) ins+='⚠️ Aumentaron los estados de tensión: observa cambios en su entorno o rutina.';
      else if(negPrev-neg>0.12) ins+='✅ Bajaron los estados de tensión respecto al período anterior. ¡Buen trabajo!';
    } else ins+='Sigue registrando para comparar con períodos anteriores.';
    document.getElementById('emoInsight').innerHTML=ins;
    this.renderEmoEvolution();
  },
  renderEmoEvolution(){
    const el=document.getElementById('emoEvo'); if(!el) return;
    const days=this.emoRangeDays;
    const buckets=days<=7?7:5; // 7 días o 5 bloques (~semanas) para el mes
    const span=days/buckets;
    const cols=[];
    for(let b=buckets-1;b>=0;b--){
      const to=Date.now()-b*span*864e5, from=to-span*864e5;
      const evs=this.state.events.filter(e=>e.ts>=from&&e.ts<to);
      const c={}; Object.keys(this.EMOS).forEach(k=>c[k]=0);
      evs.forEach(e=>{const k=this.emoOf(e); if(k) c[k]++;});
      const tot=Object.values(c).reduce((a,b)=>a+b,0);
      const lbl=days<=7
        ? ['Do','Lu','Ma','Mi','Ju','Vi','Sá'][new Date(to-43200000).getDay()]
        : `S${buckets-b}`;
      cols.push({c,tot,lbl});
    }
    const max=Math.max(...cols.map(c=>c.tot),1);
    el.innerHTML=cols.map(col=>{
      const segs=Object.entries(col.c).filter(([,v])=>v>0)
        .map(([k,v])=>`<div class="evo-seg" style="height:${v/max*100}%;background:${this.EMOS[k].color}" title="${this.EMOS[k].label}: ${v}"></div>`).join('');
      return `<div class="evo-col">${segs||'<div class="evo-seg" style="height:2px;background:var(--line)"></div>'}<span class="evo-lbl">${col.lbl}</span></div>`;
    }).join('');
  },

  /* ══════ RESUMEN DIARIO (hábito de uso) ══════
     Narra la jornada del perro: sueño estimado, energía, episodios de ansiedad,
     solicitudes de salida y comparación con su propia rutina habitual. */
  buildDailySummary(){
    const name=this.state.pet?this.state.pet.name:'Tu perro';
    const now=new Date();
    const startOfDay=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
    const today=this.state.events.filter(e=>e.ts>=startOfDay);
    // línea base: promedio diario de los 14 días previos
    const hist=this.state.events.filter(e=>e.ts<startOfDay && e.ts>startOfDay-14*864e5);
    const histDays=Math.max(1,Math.min(14,Math.ceil((startOfDay-Math.min(...(hist.length?hist.map(e=>e.ts):[startOfDay])))/864e5)));
    const baseline=hist.length/histDays;

    if(!today.length){
      return {title:`El día de ${name}`,
        text: this.state.events.length
          ? `Sin vocalizaciones registradas hoy. ${name} ha estado tranquilo — o la escucha estuvo apagada. Activa el micrófono 🎙️ para no perderte nada.`
          : `Aún no hay datos de ${name}. Activa la escucha 🎙️ o registra un evento para que empiece a construirse su historia.`,
        chips:[]};
    }
    // métricas
    const hours=[...new Set(today.map(e=>new Date(e.ts).getHours()))].sort((a,b)=>a-b);
    const quietRun=(()=>{ // mayor bloque sin eventos (proxy de descanso)
      const ts=[startOfDay,...today.map(e=>e.ts),now.getTime()].sort((a,b)=>a-b);
      let max=0; for(let i=1;i<ts.length;i++) max=Math.max(max,ts[i]-ts[i-1]);
      return max/36e5;
    })();
    const cnt=m=>today.filter(e=>e.meaning===m||(!e.meaning&&e.pred===m)).length;
    const anxious=cnt('ansioso'), wantsOut=cnt('salir'), hungry=cnt('hambre'), play=cnt('jugar');
    const barks=today.filter(e=>e.type==='ladrido').length;
    const night=today.filter(e=>{const h=new Date(e.ts).getHours(); return h<6;}).length;
    // energía relativa a su propia línea base
    let energy='normal', chipCls='';
    if(baseline>0){
      const ratio=today.length/baseline;
      if(ratio>1.5){ energy='alto'; chipCls='hot'; }
      else if(ratio<0.5){ energy='bajo'; chipCls='cool'; }
    } else energy = today.length>8?'alto':today.length<3?'bajo':'normal';

    // narrativa
    let t=`${name} `;
    t+= quietRun>=5 ? `descansó cerca de ${quietRun.toFixed(1)} horas seguidas. ` : `tuvo una jornada movida (descanso más largo: ${quietRun.toFixed(1)} h). `;
    const partes=[];
    if(wantsOut) partes.push(`pidió salir ${wantsOut} ${wantsOut===1?'vez':'veces'}`);
    if(hungry) partes.push(`mostró hambre ${hungry} ${hungry===1?'vez':'veces'}`);
    if(play) partes.push(`buscó jugar ${play} ${play===1?'vez':'veces'}`);
    if(partes.length) t+=`Hoy ${partes.join(', ')}. `;
    if(anxious){
      const hAnx=today.filter(e=>(e.meaning||e.pred)==='ansioso').map(e=>new Date(e.ts).getHours());
      const rango=hAnx.length>1&&Math.min(...hAnx)!==Math.max(...hAnx)
        ? ` entre las ${String(Math.min(...hAnx)).padStart(2,'0')}:00 y ${String(Math.max(...hAnx)+1).padStart(2,'0')}:00`
        : ` alrededor de las ${String(hAnx[0]).padStart(2,'0')}:00`;
      t+=`Mostró ${anxious} ${anxious===1?'episodio':'episodios'} de ansiedad${rango}. `;
    }
    if(night) t+=`⚠️ Hubo ${night} ${night===1?'evento':'eventos'} de madrugada — revisa si algo lo inquieta de noche. `;
    t+=`Su nivel de energía hoy es ${energy}`;
    if(baseline>0) t+= ` (${today.length} eventos vs ${baseline.toFixed(1)} de su promedio diario)`;
    t+='.';

    const chips=[`🔊 ${barks} ladridos`,`📌 ${today.length} eventos`,`😴 ${quietRun.toFixed(1)} h de calma`];
    if(anxious) chips.push(`😰 ${anxious} ansiedad`);
    if(wantsOut) chips.push(`🚪 ${wantsOut} salidas`);
    return {title:`El día de ${name}`, text:t, chips, energyCls:chipCls};
  },
  renderDaily(){
    const el=document.getElementById('dailyText'); if(!el) return;
    const s=this.buildDailySummary();
    document.getElementById('dailyTitle').textContent=s.title;
    el.textContent=s.text;
    document.getElementById('dailyChips').innerHTML=
      s.chips.map((c,i)=>`<span class="daily-chip ${i===0?(s.energyCls||''):''}">${c}</span>`).join('');
  },

  /* ══════ TRADUCTOR EN TIEMPO REAL ══════
     Escucha 10 s, junta todas las vocalizaciones detectadas y entrega la
     distribución de significados: "68% atención, 22% juego, 10% hambre". */
  translating:false, transDetections:[], _transTimer:null, _transStartedListen:false,

  // distribución de pesos de significado para un tipo de sonido (aprendido + priors)
  meaningWeights(type, ts){
    const h=new Date(ts).getHours();
    // priors etológicos por tipo de sonido y hora
    const priors={
      ladrido: h<9 ? {hambre:.38,salir:.3,atencion:.2,jugar:.12} :
               h<13? {salir:.32,jugar:.28,atencion:.22,hambre:.18} :
               h<18? {jugar:.34,atencion:.26,salir:.22,emocionado:.18} :
               h<22? {atencion:.3,hambre:.26,territorio:.24,salir:.2} :
                     {territorio:.4,ansioso:.3,asustado:.3},
      gemido:  {atencion:.38,ansioso:.28,hambre:.18,dolor:.16},
      gruñido: {territorio:.45,asustado:.28,jugar:.27},
      aullido: {ansioso:.4,atencion:.32,territorio:.28},
    };
    const prior=priors[type]||priors.ladrido;
    const labeled=this.state.events.filter(e=>e.type===type&&e.meaning);
    if(!labeled.length) return {...prior};
    // aprendizaje: ponderación gaussiana por cercanía horaria
    const w={};
    labeled.forEach(e=>{
      const eh=new Date(e.ts).getHours();
      let d=Math.abs(h-eh); d=Math.min(d,24-d);
      w[e.meaning]=(w[e.meaning]||0)+Math.exp(-(d*d)/18);
    });
    const tot=Object.values(w).reduce((a,b)=>a+b,0)||1;
    // mezcla aprendido/prior según cuánta data hay (3+ etiquetas = 80% aprendido)
    const alpha=Math.min(labeled.length/3,1)*0.8;
    const out={};
    new Set([...Object.keys(prior),...Object.keys(w)]).forEach(m=>{
      out[m]=alpha*((w[m]||0)/tot)+(1-alpha)*(prior[m]||0);
    });
    return out;
  },

  async translate(){
    if(this.translating) return;
    const btn=document.getElementById('transBtn');
    // asegurar escucha activa (temporal si hace falta)
    if(!this.listening){
      await this.toggleListen();
      if(!this.listening){ return; } // permiso denegado
      this._transStartedListen=true;
    }
    this.translating=true; this.transDetections=[];
    document.getElementById('transResult').innerHTML='';
    btn.classList.add('rec'); document.getElementById('transRing').classList.add('on');
    let remain=10;
    document.getElementById('transStatus').textContent='👂 Escuchando… 10 s';
    this._transTimer=setInterval(()=>{
      remain--;
      document.getElementById('transStatus').textContent=`👂 Escuchando… ${remain} s`;
      if(remain<=0) this.finishTranslate();
    },1000);
  },
  cancelTranslate(){
    if(!this.translating) return;
    clearInterval(this._transTimer); this.translating=false;
    const btn=document.getElementById('transBtn');
    if(btn){ btn.classList.remove('rec'); }
    const ring=document.getElementById('transRing'); if(ring) ring.classList.remove('on');
    if(this._transStartedListen){ this.stopListen(); this._transStartedListen=false; }
  },
  finishTranslate(){
    clearInterval(this._transTimer); this.translating=false;
    document.getElementById('transBtn').classList.remove('rec');
    document.getElementById('transRing').classList.remove('on');
    if(this._transStartedListen){ this.stopListen(); this._transStartedListen=false; }
    document.getElementById('transStatus').textContent='';
    if(!this.transDetections.length){
      document.getElementById('transResult').innerHTML=
        `<div class="trans-result-card"><h4>🤫 No escuché vocalizaciones</h4>
         <p class="trans-phrase">Inténtalo de nuevo cuando tu perro esté ladrando, gimiendo o gruñendo cerca del teléfono.</p></div>`;
      return;
    }
    this.renderTranslation(this.transDetections);
  },
  renderTranslation(dets){
    // acumular distribución ponderada por confianza acústica
    const acc={};
    dets.forEach(d=>{
      const w=this.meaningWeights(d.type, Date.now());
      for(const m in w) acc[m]=(acc[m]||0)+w[m]*d.conf;
    });
    const tot=Object.values(acc).reduce((a,b)=>a+b,0)||1;
    const top=Object.entries(acc).map(([m,v])=>[m,v/tot]).sort((a,b)=>b[1]-a[1]).slice(0,3);
    // normalizar el top-3 a 100%
    const t3=top.reduce((a,b)=>a+b[1],0);
    const rows=top.map(([m,v])=>[m,Math.round(v/t3*100)]);
    // ajustar redondeo a 100
    const diff=100-rows.reduce((a,b)=>a+b[1],0); rows[0][1]+=diff;
    const name=this.state.pet?this.state.pet.name:'Tu perro';
    const nLabeled=this.state.events.filter(e=>e.meaning).length;
    const html=`<div class="trans-result-card">
      <h4>💬 ${name} dice:</h4>
      <p class="trans-phrase">"${rows.map(([m,p])=>`${p}% ${this.meaningPhrase(m)}`).join(' · ')}"</p>
      ${rows.map(([m,p])=>`
        <div class="trans-bar"><span class="te">${MEANINGS[m].emoji}</span>
          <div class="tinfo"><div class="tname"><span>${MEANINGS[m].label}</span><span class="tpct">${p}%</span></div>
          <div class="ttrack"><div class="tfill" data-w="${p}"></div></div></div>
        </div>`).join('')}
      <p class="trans-note">Basado en ${dets.length} vocalización(es) y ${nLabeled} evento(s) etiquetados de ${name}. Etiqueta más eventos para afinar la traducción 🧠</p>
    </div>`;
    document.getElementById('transResult').innerHTML=html;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      document.querySelectorAll('.tfill').forEach(f=>f.style.width=f.dataset.w+'%');
    }));
  },
  translateDemo(){
    this.transDetections=[{type:'ladrido',conf:.85},{type:'ladrido',conf:.7},{type:'gemido',conf:.6}];
    this.renderTranslation(this.transDetections);
    document.getElementById('transStatus').textContent='';
  },

  /* ══════ 1) PREDICCIÓN DE NECESIDADES ══════
     Analiza los eventos confirmados por minuto-del-día y anticipa la próxima
     necesidad en una ventana de 90 min. "Rocky suele pedir salir en ~15 min". */
  predictNext(){
    const labeled=this.state.events.filter(e=>e.meaning);
    if(labeled.length<3) return null;
    const now=new Date(); const nowMin=now.getHours()*60+now.getMinutes();
    const days=Math.max(1,(Date.now()-Math.min(...labeled.map(e=>e.ts)))/864e5);
    const win={}; // meaning -> [offsets en min]
    labeled.forEach(e=>{
      const d=new Date(e.ts); const m=d.getHours()*60+d.getMinutes();
      let off=m-nowMin; if(off<0) off+=1440;
      if(off<=90) (win[e.meaning]=win[e.meaning]||[]).push(off);
    });
    let best=null;
    for(const [meaning,offs] of Object.entries(win)){
      if(offs.length<2) continue; // exige patrón repetido
      const median=offs.sort((a,b)=>a-b)[Math.floor(offs.length/2)];
      const score=offs.length/days;
      if(!best||score>best.score) best={meaning,median:Math.max(5,Math.round(median/5)*5),count:offs.length,score};
    }
    return best;
  },
  renderPrediction(){
    const el=document.getElementById('predictText'); if(!el) return;
    const name=this.state.pet?this.state.pet.name:'Tu perro';
    const p=this.predictNext();
    if(!p){ el.textContent=`Aprendiendo la rutina de ${name} — etiqueta más eventos para activar predicciones`; return; }
    el.textContent=`${name} suele ${this.meaningPhrase(p.meaning).replace('tiene','tener').replace('quiere','pedir').replace('está','estar').replace('busca','buscar').replace('siente','sentir')} en los próximos ~${p.median} min (patrón visto ${p.count} veces)`;
  },

  /* ══════ 2) CÁMARA IA — lenguaje corporal ══════
     Detección de perro (COCO-SSD) + análisis de movimiento por diferencia de
     fotogramas durante 10 s → nivel de agitación → estado corporal. */
  camStream:null, camModel:null, camAnalyzing:false,
  async camAction(){
    const btn=document.getElementById('camBtn');
    if(!this.camStream){ // encender
      try{
        this.camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
      }catch(e){ this.toast('Permiso de cámara denegado 📷🚫'); return; }
      document.getElementById('camVideo').srcObject=this.camStream;
      document.getElementById('camOverlay').classList.add('hidden');
      btn.textContent='🔍 Analizar 10 segundos';
      document.getElementById('camStatus').textContent='Encuadra a tu perro y presiona Analizar';
      if(window.cocoSsd && !this.camModel) cocoSsd.load().then(m=>this.camModel=m).catch(()=>{});
      return;
    }
    if(this.camAnalyzing) return;
    this.camAnalyzing=true; btn.textContent='Analizando…'; btn.disabled=true;
    const video=document.getElementById('camVideo'), canvas=document.getElementById('camCanvas');
    const ov=document.getElementById('camOverlay'); ov.classList.remove('hidden'); ov.classList.add('analyzing');
    canvas.width=96; canvas.height=72; const ctx=canvas.getContext('2d',{willReadFrequently:true});
    let prev=null, scores=[], dogSeen=false, dogConf=0, t0=Date.now();
    // detección de perro en paralelo (una pasada por segundo)
    const dogTimer=setInterval(async()=>{
      if(this.camModel){ try{
        const preds=await this.camModel.detect(video);
        const dog=preds.find(p=>p.class==='dog'&&p.score>0.5);
        if(dog){ dogSeen=true; dogConf=Math.max(dogConf,dog.score); }
      }catch(e){} }
    },1000);
    await new Promise(res=>{
      const iv=setInterval(()=>{
        const remain=10-Math.floor((Date.now()-t0)/1000);
        ov.textContent=`🧠 Analizando lenguaje corporal… ${remain}s`;
        ctx.drawImage(video,0,0,96,72);
        const d=ctx.getImageData(0,0,96,72).data;
        const gray=new Float32Array(96*72);
        for(let i=0;i<gray.length;i++){ const j=i*4; gray[i]=(d[j]+d[j+1]+d[j+2])/765; }
        if(prev){ let diff=0; for(let i=0;i<gray.length;i++) diff+=Math.abs(gray[i]-prev[i]); scores.push(diff/gray.length); }
        prev=gray;
        if(Date.now()-t0>=10000){ clearInterval(iv); res(); }
      },180);
    });
    clearInterval(dogTimer);
    const avg=scores.reduce((a,b)=>a+b,0)/scores.length;
    const sustained=scores.filter(s=>s>0.055).length/scores.length;
    const name=this.state.pet?this.state.pet.name:'Tu perro';
    let cls,emoji,verdict,advice;
    if(avg<0.016&&sustained<0.1){ cls='calm'; emoji='😌'; verdict=`${name} parece relajado y receptivo`; advice='Postura estable, movimiento mínimo. Buen momento para acariciarlo o entrenar.'; }
    else if(avg<0.05){ cls='calm'; emoji='🙂'; verdict=`${name} está tranquilo y atento`; advice='Movimiento moderado y controlado. Estado ideal.'; }
    else if(sustained<0.5){ cls='play'; emoji='⚡'; verdict=`${name} está activo/juguetón`; advice='Mucho movimiento de cola y cuerpo. Probablemente quiere jugar o salir.'; }
    else { cls='stress'; emoji='😰'; verdict=`${name} muestra señales de ansiedad moderada`; advice='Agitación alta y sostenida (ritmo inquieto). Revisa estímulos: ruidos, visitas, encierro. Si persiste, consulta al veterinario.'; }
    const level=Math.min(100,Math.round(avg*1400));
    document.getElementById('camResult').innerHTML=`
      <div class="cam-result-card ${cls}">
        <span class="big">${emoji} ${verdict}</span>
        ${dogSeen?`🐕 Perro detectado (${Math.round(dogConf*100)}% confianza)`:'⚠️ No se detectó claramente un perro en cuadro'}<br>${advice}
        <div class="cam-meter"><div style="width:${level}%"></div></div>
        <small>Nivel de agitación: ${level}/100</small>
      </div>`;
    (this.state.cameraLogs=this.state.cameraLogs||[]).push({ts:Date.now(),avg,sustained,cls,dogSeen}); this.save();
    ov.classList.add('hidden'); ov.classList.remove('analyzing');
    this.camAnalyzing=false; btn.disabled=false; btn.textContent='🔍 Analizar de nuevo';
  },
  stopCamera(){
    if(this.camStream){ this.camStream.getTracks().forEach(t=>t.stop()); this.camStream=null; }
    const btn=document.getElementById('camBtn'); if(btn){ btn.textContent='Encender cámara'; btn.disabled=false; }
    const ov=document.getElementById('camOverlay'); if(ov){ ov.classList.remove('hidden','analyzing'); ov.textContent='Cámara apagada'; }
  },

  /* ══════ 3) MODO AUSENCIA — ansiedad por separación ══════
     Marca tu salida, escucha mientras no estás y al volver entrega el informe:
     latencia del primer ladrido, total de eventos y veredicto de ansiedad. */
  toggleAbsence(){
    const btn=document.getElementById('absBtn'), hero=document.getElementById('absHero'), st=document.getElementById('absStatus');
    if(!this.state.absence||!this.state.absence.active){
      this.state.absence={active:true,start:Date.now(),events:[]}; this.save();
      btn.textContent='🏡 ¡Ya volví!'; btn.classList.add('leaving');
      hero.textContent='👂'; hero.classList.add('active');
      st.textContent='Modo ausencia ACTIVO. Deja el teléfono cerca de tu perro y vete tranquilo. Registraré todo lo que pase.';
      document.getElementById('absSummary').innerHTML='';
      if(!this.listening) this.toggleListen();
      this.toast('Modo ausencia activado 🚪 ¡Que te vaya bien!');
    } else {
      const a=this.state.absence; a.active=false;
      const durMin=Math.round((Date.now()-a.start)/60000);
      const evs=a.events;
      const firstLat=evs.length?Math.round((evs[0].ts-a.start)/60000):null;
      const barks=evs.filter(e=>e.type==='ladrido').length, whines=evs.filter(e=>e.type==='gemido').length;
      const firstHourEvs=evs.filter(e=>e.ts-a.start<36e5).length;
      const anxious=(firstLat!==null&&firstLat<=15&&firstHourEvs>=3)||whines>=4;
      const name=this.state.pet?this.state.pet.name:'Tu perro';
      this.state.lastAbsence={ts:Date.now(),durMin,total:evs.length,firstLat,barks,whines,anxious}; this.save();
      btn.textContent='🚶 Me voy de casa'; btn.classList.remove('leaving');
      hero.textContent='🚪'; hero.classList.remove('active');
      st.textContent='Activa este modo al salir de casa.';
      if(this.listening) this.stopListen();
      document.getElementById('absSummary').innerHTML=`
        <div class="abs-summary-card">
          <h4>📋 Informe de ausencia (${durMin} min)</h4>
          ${firstLat!==null?`<p>⏱️ ${name} comenzó a vocalizar <b>${firstLat} min después de tu partida</b>.</p>`:`<p>😴 ${name} no vocalizó durante tu ausencia. ¡Excelente!</p>`}
          <p>🐕 Ladridos: <b>${barks}</b> · 😢 Gemidos: <b>${whines}</b> · Total eventos: <b>${evs.length}</b></p>
          <div class="verdict ${anxious?'warn':'ok'}">
            ${anxious?`😰 Señales de posible ansiedad por separación. Prueba salidas cortas graduales, juguetes interactivos o consulta a un etólogo.`:`✅ Sin señales de ansiedad por separación. ${name} tolera bien quedarse solo.`}
          </div>
        </div>`;
      this.toast('¡Bienvenido de vuelta! Informe generado 📋');
      this.renderHome && this.renderAlerts();
    }
  },

  /* ---------- stats ---------- */
  renderStats(){
    const ev=this.state.events;
    document.getElementById('statTotal').textContent=ev.length;
    const week=Date.now()-7*864e5;
    document.getElementById('statWeek').textContent=ev.filter(e=>e.ts>week).length;
    const withPred=ev.filter(e=>e.meaning&&e.pred);
    const acc=withPred.length? Math.round(withPred.filter(e=>e.meaning===e.pred).length/withPred.length*100)+'%':'—';
    document.getElementById('statAcc').textContent=acc;
    this.renderEmotional();
    // horas
    const hours=Array(24).fill(0); ev.forEach(e=>hours[new Date(e.ts).getHours()]++);
    const hmax=Math.max(...hours,1);
    document.getElementById('chartHours').innerHTML=hours.map((v,i)=>
      `<div class="bar" style="height:${v/hmax*100}%">${i%6===0?`<span class="bl">${i}h</span>`:''}</div>`).join('');
    // significados
    const cnt={}; ev.filter(e=>e.meaning).forEach(e=>cnt[e.meaning]=(cnt[e.meaning]||0)+1);
    const entries=Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
    const mmax=Math.max(...entries.map(e=>e[1]),1);
    document.getElementById('chartMeanings').innerHTML=entries.map(([m,v])=>
      `<div class="hrow"><span class="hlabel">${MEANINGS[m].emoji} ${MEANINGS[m].label}</span><div class="htrack"><div class="hfill" style="width:${v/mmax*100}%"></div></div><span class="hnum">${v}</span></div>`).join('')
      ||'<p class="empty">Etiqueta eventos para ver significados.</p>';
    // semana
    const days=Array(7).fill(0); const names=['Do','Lu','Ma','Mi','Ju','Vi','Sá'];
    ev.filter(e=>e.ts>week).forEach(e=>days[new Date(e.ts).getDay()]++);
    const dmax=Math.max(...days,1);
    document.getElementById('chartWeek').innerHTML=days.map((v,i)=>
      `<div class="bar" style="height:${v/dmax*100}%"><span class="bl">${names[i]}</span></div>`).join('');
  },

  /* ---------- util ---------- */
  toast(msg){
    const t=document.getElementById('toast'); t.textContent=msg; t.hidden=false;
    clearTimeout(this._tt); this._tt=setTimeout(()=>t.hidden=true, 3200);
  },
  notify(title, body){
    if(this.state.settings.notif && window.Notification && Notification.permission==='granted')
      new Notification(title,{body, icon:'icon.png'});
  },
  exportData(){
    const blob=new Blob([JSON.stringify(this.state,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='dogtalk_datos.json'; a.click();
  },
  resetAll(){
    if(confirm('¿Borrar TODOS los datos de DogTalk AI?')){ localStorage.removeItem('dogtalk'); location.reload(); }
  },

  /* ---------- init ---------- */
  init(){
    this.load();
    this.bindActive();
    // chips seleccionables
    document.querySelectorAll('.chip-row').forEach(row=>{
      row.addEventListener('click',e=>{
        if(!e.target.classList.contains('chip')) return;
        row.querySelectorAll('.chip').forEach(c=>c.classList.remove('sel'));
        e.target.classList.add('sel');
      });
    });
    document.getElementById('histFilter').addEventListener('click',e=>{
      if(e.target.classList.contains('chip')) this.renderHistory(e.target.dataset.v);
    });
    document.getElementById('emoRange').addEventListener('click',e=>{
      if(!e.target.classList.contains('chip')) return;
      document.querySelectorAll('#emoRange .chip').forEach(c=>c.classList.remove('sel'));
      e.target.classList.add('sel');
      this.emoRangeDays=+e.target.dataset.v;
      this.renderEmotional();
    });
    document.querySelectorAll('.label-btn').forEach(b=>b.addEventListener('click',()=>this.applyLabel(b.dataset.m)));
    document.getElementById('sheetBackdrop').addEventListener('click',()=>this.closeSheet());
    document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>this.go(t.dataset.s)));
    document.getElementById('carnetFile').addEventListener('change',e=>{
      [...e.target.files].forEach(f=>this.addCarnet(f)); e.target.value='';
    });
    document.getElementById('petPhoto').addEventListener('change',e=>{
      const f=e.target.files[0]; if(!f) return;
      const r=new FileReader();
      r.onload=()=>{ this._photoData=r.result; document.getElementById('photoPicker').innerHTML=`<img src="${r.result}">`; };
      r.readAsDataURL(f);
    });
    // settings persist
    const sn=document.getElementById('setNotif'), sa=document.getElementById('setAutoListen');
    sn.checked=this.state.settings.notif; sa.checked=this.state.settings.autoListen;
    sn.onchange=()=>{this.state.settings.notif=sn.checked; this.save();};
    sa.onchange=()=>{this.state.settings.autoListen=sa.checked; this.save();};
    // mascota interactiva
    const mascot=document.getElementById('mascot');
    if(mascot) mascot.addEventListener('click',()=>{
      mascot.textContent=['🐶','🐕','🦮','🐩','🐕‍🦺'][Math.floor(Math.random()*5)];
      this.toast(['¡Guau guau! 🐾','¡Woof! ❤️','*mueve la cola* 🐕','¡Arf arf! 🎾'][Math.floor(Math.random()*4)]);
    });
    // pantalla inicial
    if(this.state.pet){
      // precargar formulario para edición
      const p=this.state.pet;
      document.getElementById('petName').value=p.name||'';
      document.getElementById('petBreed').value=p.breed||'';
      document.getElementById('petAge').value=p.age||'';
      document.getElementById('petWeight').value=p.weight||'';
      document.getElementById('petMedical').value=p.medical||'';
      if(p.photo) document.getElementById('photoPicker').innerHTML=`<img src="${p.photo}">`;
      this.go('home');
    }
    // restaurar UI de modo ausencia si quedó activo
    if(this.state.absence&&this.state.absence.active){
      const btn=document.getElementById('absBtn');
      btn.textContent='🏡 ¡Ya volví!'; btn.classList.add('leaving');
      document.getElementById('absHero').textContent='👂';
      document.getElementById('absHero').classList.add('active');
      document.getElementById('absStatus').textContent='Modo ausencia ACTIVO (recuerda reactivar la escucha 🎙️).';
    }
    this.loadModel();
    if(this.state.settings.autoListen && this.state.pet) this.toggleListen();
  },
};

App.init();

/* PWA: registrar service worker + banner de instalación */
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(e=>console.warn('SW',e)));
}
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault(); deferredPrompt=e;
  const b=document.createElement('button');
  b.className='install-fab'; b.innerHTML='📲 Instalar app';
  b.onclick=async()=>{ b.remove(); deferredPrompt.prompt();
    const {outcome}=await deferredPrompt.userChoice;
    if(outcome==='accepted') App.toast('¡DogTalk AI instalada! 🐾');
    deferredPrompt=null; };
  document.body.appendChild(b);
  setTimeout(()=>b.remove(),20000);
});
// atajos del manifest (#translate, #absence, #vet)
if(location.hash) setTimeout(()=>{
  const s=location.hash.slice(1);
  if(document.getElementById('screen-'+s)) App.go(s);
},100);
