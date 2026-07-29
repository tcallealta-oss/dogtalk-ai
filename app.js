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
    // migración v0.9 → v1.0 (salud diaria: edad exacta, comidas, peso, síntomas, medicamentos)
    const s=this.state;
    s.settings=s.settings||{};
    if(s.settings.medRem===undefined) s.settings.medRem=true;
    if(s.settings.mealRem===undefined) s.settings.mealRem=true;
    if(!s.settings.sensitivity) s.settings.sensitivity='media';
    s.users=s.users||{}; s.remFired=s.remFired||{}; s.rejected=s.rejected||[]; s.fpCount=s.fpCount||{};
    (s.pets||[]).forEach(p=>{
      p.weights=p.weights||[]; p.symptoms=p.symptoms||[]; p.meds=p.meds||[];
      if(!p.meals) p.meals={times:[],grams:null,log:{}};
      // el peso del perfil pasa a ser el primer punto de la curva
      if(!p.weights.length && parseFloat(p.weight)>0)
        p.weights.push({id:'w'+(p.id||'')+'0', date:this.dateKey(), kg:parseFloat(p.weight)});
      // la edad decimal antigua se conserva como años+meses aproximados
      if(p.ageY===undefined && p.age!==undefined && p.age!=='' && p.age!==null && !p.birth){
        const m=Math.round(parseFloat(p.age)*12);
        if(!isNaN(m)){ p.ageY=Math.floor(m/12); p.ageM=m%12; }
      }
    });
    this.seedDemo();
    this.syncAges();
    this.save();
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
    const ARR=['events','vaccines','carnet','weights','symptoms','meds'];
    [...ARR,'lastAbsence','absence','meals'].forEach(k=>{
      Object.defineProperty(s,k,{configurable:true,
        get:()=>{ if(!P) return ARR.includes(k)?[]:null;
                  if(ARR.includes(k)&&!P[k]) P[k]=[];
                  if(k==='meals'&&!P.meals) P.meals={times:[],grams:null,log:{}};
                  return P[k]; },
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
        <div>${p.name}<span class="ps-meta">${[p.breed,this.ageMonths(p)!=null?this.ageLabel(p):''].filter(Boolean).join(' · ')||'Sin datos'}</span></div>
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
    ['petName','petBreed','petBirth','petAgeY','petAgeM','petWeight','petMedical'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('ageHint').textContent='Si no la sabes exacta, deja el campo vacío y usa la edad aproximada.';
    document.querySelectorAll('#petSex .chip,#petActivity .chip,#petNeutered .chip').forEach(c=>c.classList.remove('sel'));
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
    const a=this.account();
    if(!a.card){
      this._pendingPlan=plan;
      this.toast('Primero asocia un método de pago 💳');
      this.go('account'); setTimeout(()=>this.openPaySheet(),350); return;
    }
    this.state.plan=plan; this.syncUserPlan(); this.save();
    const total=this.planTotalCLP();
    const nd=new Date(); nd.setMonth(nd.getMonth()+1);
    a.nextCharge=nd.getTime(); a.autoRenew=true; a.canceledAt=null;
    const extra=this.state.extraPets||0;
    a.invoices.push({ts:Date.now(), clp:total,
      desc:`${this.PLANS[plan].name}${extra?` + ${extra} mascota(s) extra`:''} · ${a.card.brand} ••••${a.card.last4}`});
    this.save(); this.renderPlan(); this.confetti(); this.renderTrial();
    this.toast(`${this.PLANS[plan].name} activado ⭐ Se renueva el ${nd.toLocaleDateString('es-CL')}`);
  },
  save(){ localStorage.setItem('dogtalk', JSON.stringify(this.state)); this.queueAlarmSync(); },
  // reprogramar las alarmas del sistema es caro: lo agrupamos tras el último cambio
  queueAlarmSync(){ clearTimeout(this._alarmT); this._alarmT=setTimeout(()=>this.syncNativeAlarms&&this.syncNativeAlarms(), 1500); },

  /* ---------- navegación ---------- */
  go(name){
    if(!this.gate(name)) return;
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('screen-'+name).classList.add('active');
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.s===name));
    if(name==='home') this.renderHome();
    if(name==='history') this.renderHistory('todos');
    if(name==='stats') this.renderStats();
    if(name==='vet') this.renderVet();
    if(name==='health') this.renderHealth();
    if(name==='food') this.renderFood();
    if(name==='meds') this.renderMeds();
    if(name==='symptoms') this.renderSymptoms();
    if(name==='meals') this.renderMeals();
    if(name==='weight') this.renderWeight();
    if(name==='subscription') this.renderPlan();
    if(name==='account') this.renderAccount();
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
    const val = id => document.getElementById(id).value;
    const birth = val('petBirth')||null;
    if(birth && new Date(birth+'T12:00:00') > new Date()){ this.toast('La fecha de nacimiento no puede ser futura 📅'); return; }
    const base = {
      name, breed: val('petBreed').trim(), birth,
      ageY: val('petAgeY')===''?null:+val('petAgeY'), ageM: val('petAgeM')===''?null:+val('petAgeM'),
      weight: val('petWeight'), sex: sel('petSex'), neutered: sel('petNeutered'),
      activity: sel('petActivity'), medical: val('petMedical').trim(),
    };
    base.age = this.ageYears(base);
    if(this._newPet){ // crear mascota adicional
      this.state.pets.push({id:'p'+Date.now(), ...base,
        photo:this._photoData||null, events:[], vaccines:[], carnet:[],
        weights:base.weight?[{id:'w'+Date.now(), date:this.dateKey(), kg:parseFloat(base.weight)}]:[],
        symptoms:[], meds:[], meals:{times:[],grams:null,log:{}}});
      this.state.activePet=this.state.pets.length-1;
      this._newPet=false; this._photoData=null; this.bindActive(); this.save();
      this.toast(`¡${name} agregado! Ahora tienes ${this.state.pets.length} mascotas 🐾`);
      this.go('home'); return;
    }
    const prev=this.state.pet||{};
    this.state.pet = {...base, photo: this._photoData || prev.photo || null};
    // si cambió el peso a mano, queda como punto nuevo de la curva
    const kg=parseFloat(base.weight);
    if(kg>0){
      const list=this.state.weights, k=this.dateKey();
      const today=list.find(w=>w.date===k);
      const last=list.slice().sort((a,b)=>a.date.localeCompare(b.date)).pop();
      if(today) today.kg=kg;
      else if(!last||last.kg!==kg) list.push({id:'w'+Date.now(), date:k, kg});
    }
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
    const wb=document.getElementById('wbName'); if(wb&&p) wb.textContent=p.name;
    document.getElementById('moodValue').textContent = mood;
    document.getElementById('moodSub').textContent = sub;
    this.renderTrial();
    this.renderDaily();
    this.renderAgenda();
    this.renderPrediction();
    this.renderAlerts();
    const feed = document.getElementById('recentEvents');
    feed.innerHTML = this.state.events.slice(-5).reverse().map(e=>this.eventHTML(e)).join('') || this.emptyIllu('Aún no hay eventos.<br>Toca 🎙️ Escuchar o registra el primero.');
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
    // ── salud diaria ──
    const sv=this.symptomVerdict();
    if(sv.level==='urgent') alerts.push(['danger','🚨',`${sv.title}. ${sv.reasons[0]||''}`]);
    else if(sv.level==='vet') alerts.push(['warn','⚠️',`${sv.title}: ${sv.reasons[0]||''}`]);
    const overdue=this.medDosesToday().filter(d=>d.st==='due');
    if(overdue.length) alerts.push(['warn','💊',`${overdue.length} ${overdue.length===1?'toma atrasada':'tomas atrasadas'} hoy (${overdue.map(d=>d.med.name+' '+d.time).join(', ')}).`]);
    const wt=this.weightTrend(30);
    if(wt&&Math.abs(wt.pct)>=10) alerts.push(['warn','⚖️',`El peso ${wt.diff>0?'subió':'bajó'} ${Math.abs(wt.pct)}% en 30 días (${wt.from.kg} → ${wt.to.kg} kg). Vale la pena revisarlo con el veterinario.`]);
    const mealsT=this.mealsOf(), lgT=(mealsT.log||{})[this.dateKey()]||{};
    const nowM=new Date().getHours()*60+new Date().getMinutes();
    const missedMeals=(mealsT.times||[]).filter(t=>!lgT[t]&&this.minOf(t)<nowM-60);
    if(missedMeals.length) alerts.push(['info','🍲',`Sin marcar la comida de las ${missedMeals.join(' y ')}. ¿Ya comió?`]);
    const bag=this.bagStatus();
    if(bag&&!bag.unknown){
      if(bag.left<=0) alerts.push(['warn','🛍️','El saco de alimento debería estar terminado. Registra el nuevo para seguir el cálculo.']);
      else if(bag.left<=7) alerts.push(['info','🛍️',`Quedan ~${bag.left} días de alimento. Buen momento para comprar el próximo saco.`]);
    }
    if(this.isBirthday()) alerts.push(['info','🎂',`¡Hoy ${this.state.pet.name} cumple ${Math.floor(this.ageMonths()/12)} años! 🎉`]);
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
        ${e.ac&&e.ac.f0?`<p class="event-ac">🔬 ${this.acousticSummary(e.ac)}${e.emoLabel?` · ${e.emoLabel}`:''}</p>`:''}
      </div>
      ${e.conf?`<span class="event-conf">${Math.round(e.conf*100)}%</span>`:''}
      <div class="event-acts">
        ${!e.meaning?`<button class="tag-btn" onclick="App.openLabelSheet(${e.id})">Etiquetar</button>`:''}
        <button class="fp-btn" onclick="App.openFpSheet(${e.id})" title="No era mi perro">🚫 No era él</button>
      </div>
    </div>`;
  },
  rejectedHTML(e){
    const st=SOUND_TYPES[e.type]||{emoji:'🎵',label:e.type};
    const r=this.FP_REASONS[e.fp]||{e:'❓',l:'Descartado'};
    const d=new Date(e.ts);
    return `<div class="event-item rejected">
      <span class="event-emoji">${r.e}</span>
      <div class="event-info">
        <p class="event-title">${st.label} — descartado: ${r.l}</p>
        <p class="event-meta">${d.toLocaleDateString('es-CL',{day:'2-digit',month:'2-digit'})} ${d.toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'})}${e.cls?' · clase IA: '+e.cls:''}</p>
      </div>
      <button class="tag-btn" onclick="App.restoreEvent(${e.id})">↩️ Restaurar</button>
    </div>`;
  },
  _histFilter:'todos',
  renderHistory(filter){
    this._histFilter=filter;
    document.querySelectorAll('#histFilter .chip').forEach(c=>c.classList.toggle('sel', c.dataset.v===filter));
    if(filter==='descartados'){
      const rej=(this.state.rejected||[]).slice().reverse();
      const fp=this.state.fpCount||{};
      const top=Object.entries(fp).sort((a,b)=>b[1]-a[1]).slice(0,3);
      document.getElementById('historyList').innerHTML =
        (top.length?`<div class="fp-summary">🎯 Umbral reforzado en: ${top.map(([c,n])=>`<b>${c}</b> (${n})`).join(', ')}</div>`:'')
        + (rej.map(e=>this.rejectedHTML(e)).join('') || this.emptyIllu('No has descartado ningún sonido.<br>Usa 🚫 <b>No era él</b> cuando la IA se equivoque.'));
      return;
    }
    const list = this.state.events.filter(e=>filter==='todos'||e.type===filter).slice().reverse();
    document.getElementById('historyList').innerHTML = list.map(e=>this.eventHTML(e)).join('') || this.emptyIllu('Sin eventos con este filtro.');
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

  addEvent(type, conf, ac, cls){
    const ts=Date.now();
    let pred=this.predictMeaning(type, ts);
    let emo=null;
    if(ac && ac.f0!==undefined){
      emo=this.emotionFromAcoustics(ac, type);
      const labeled=this.state.events.filter(e=>e.type===type&&e.meaning).length;
      // con poco historial mandan los parámetros acústicos; con datos manda lo aprendido
      if(labeled<4 || emo.arousal>0.75 || emo.arousal<0.25){
        pred={meaning:emo.meaning, conf:Math.max(pred.conf, 0.55+Math.abs(emo.arousal-0.5)*0.6)};
      }
    }
    const e={id:ts, ts, type, conf, cls:cls||null, pred:pred.meaning, predConf:pred.conf, meaning:null,
      ac:ac||null, valence:emo?emo.valence:null, arousal:emo?emo.arousal:null, emoLabel:emo?emo.label:null};
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
      if(e){ e.meaning=meaning; this.save(); this.confetti(); this.toast(`¡Gracias! La IA de ${this.state.pet?this.state.pet.name:'tu perro'} aprendió 🧠`); }
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
          this.classNames[idx]=name;
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
    if(!this.requirePro('La escucha en vivo')) return;
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
    if(window.Notification && Notification.permission==='default') await Notification.requestPermission();
    this.micIndicator(true);
  },
  stopListen(){
    if(this.procNode) this.procNode.disconnect();
    if(this.audioCtx) this.audioCtx.close();
    if(this.stream) this.stream.getTracks().forEach(t=>t.stop());
    this.listening=false;
    document.getElementById('micBtn').classList.remove('rec');
    document.getElementById('pulseRing').classList.remove('on');
    document.getElementById('listenStatus').textContent='Detección pausada';
    this.micIndicator(false);
  },
  /* Sonidos que suelen provocar falsos positivos: TV, radio, voces, música.
     Si alguno domina la escena por encima del sonido canino, lo más probable
     es que el "ladrido" venga de un parlante y no del perro de la casa. */
  DISTRACTOR_RE:/^(speech|television|radio|music|singing|conversation|narration|male speech|female speech|child speech|babbling|soundtrack|theme music|background music|musical instrument|video game music|whistling|shout|yell|children shouting|crowd|applause|laughter|chatter)/i,
  classNames:{},
  topDistractor(mean){
    let top=null;
    for(const idx in this.classNames){
      if(!this.DISTRACTOR_RE.test(this.classNames[idx])) continue;
      const s=mean[idx];
      if(s>0.18 && (!top||s>top.s)) top={name:this.classNames[idx], s};
    }
    return top;
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
      const thr=this.baseThreshold();
      let best=null;
      for(const idx in this.dogClassIdx){
        const name=this.dogClassIdx[idx], s=mean[idx];
        // el umbral sube en las clases que ya marcaste como error
        if(s > thr+this.fpBoost(name) && (!best||s>best.s)) best={s, name};
      }
      if(best){
        // filtro anti-TV: si la fuente mediática/humana domina, descartamos
        const dist=this.topDistractor(mean);
        if(dist && dist.s > best.s*1.15){
          this.lastDetectAt=Date.now();
          const feed=document.getElementById('detectFeed');
          if(feed) feed.insertAdjacentHTML('afterbegin',
            `<div class="skip-item">🔇 Sonido ignorado — parecía <b>${dist.name}</b> (${Math.round(dist.s*100)}%), no ${this.state.pet?this.state.pet.name:'tu perro'}.</div>`);
          return;
        }
        this.lastDetectAt=Date.now();
        const type=YAMNET_MAP[best.name]||'ladrido';
        const ac=this.analyzeAcoustics(samples, 16000);
        this.addEvent(type, best.s, ac, best.name);
      }
    }catch(e){ console.error('classify',e); }
  },

  simulateDetection(){
    const types=['ladrido','ladrido','gemido','gruñido','aullido'];
    const t=types[Math.floor(Math.random()*types.length)];
    const base={ladrido:[350,900],gemido:[500,1100],gruñido:[120,300],aullido:[400,800]}[t];
    const ac={f0:Math.round(base[0]+Math.random()*(base[1]-base[0])),
      hnr:+(0.25+Math.random()*0.6).toFixed(2), rms:+(0.02+Math.random()*0.15).toFixed(4),
      interval:Math.random()>0.4?Math.round(300+Math.random()*1500):null, burst:1+Math.floor(Math.random()*4)};
    this.addEvent(t, 0.55+Math.random()*0.4, ac);
  },

  /* ══════ CALCULADORA DE RACIÓN ══════
     Fórmula veterinaria estándar: RER = 70 × peso^0.75 ; MER = RER × factor
     El factor depende de edad, esterilización y nivel de actividad. */
  // versión numérica: la usan la pantalla de comidas, la de peso y el chat
  rationCalc(p){
    if(!p) return null;
    const w=parseFloat(p.weight);
    if(!w||w<=0) return null;
    const months=this.ageMonths(p);
    const age = months==null ? null : months/12;
    const rer=70*Math.pow(w,0.75);
    let factor, etapa;
    if(age!=null&&age<0.34){ factor=3.0; etapa='cachorro menor de 4 meses'; }
    else if(age!=null&&age<1){ factor=2.0; etapa='cachorro de 4 a 12 meses'; }
    else if(age!=null&&age>=8){ factor=1.4; etapa='adulto senior'; }
    // la esterilización baja el gasto energético entre un 20% y un 30%
    else if(p.neutered==='si'){ factor=p.activity==='alto'?1.6:p.activity==='bajo'?1.2:1.4;
      etapa=`adulto esterilizado con actividad ${({alto:'alta',bajo:'baja',medio:'media'})[p.activity]||'media'}`; }
    else if(p.activity==='alto'){ factor=1.8; etapa='adulto muy activo'; }
    else if(p.activity==='bajo'){ factor=1.4; etapa='adulto poco activo'; }
    else { factor=1.6; etapa='adulto con actividad media'; }
    const mer=Math.round(rer*factor);
    // alimento seco típico: 3.500–4.000 kcal/kg → usamos 3.700 kcal/kg = 3,7 kcal/g
    const grams=Math.round(mer/3.7);
    const tomas=(age!=null&&age<0.5)?4:(age!=null&&age<1)?3:2;
    return {w, rer:Math.round(rer), mer, grams, tomas, factor, etapa,
      perMeal:Math.round(grams/tomas), stage:this.lifeStage(p)};
  },
  rationAdvice(p){
    const r=this.rationCalc(p);
    if(!r) return `Para calcular la ración de ${p.name} necesito su <b>peso</b>. Agrégalo en su perfil (⚙️ → Editar perfil de mascota) y vuelve a preguntarme.
<br><br>Como referencia general: un perro adulto come entre el <b>2% y 3% de su peso corporal</b> al día en alimento seco, repartido en 2 tomas.`;
    const {w, rer, mer, grams:gr, tomas, factor, etapa}=r;
    return `Para <b>${p.name}</b> (${w} kg, ${etapa}):
<br><br>🔥 <b>Necesidad energética:</b> ~${mer} kcal al día
<br>🥣 <b>Alimento seco:</b> aproximadamente <b>${gr} g diarios</b>, repartidos en <b>${tomas} tomas</b> (~${Math.round(gr/tomas)} g por comida)
<br><br><b>Importante:</b> es una estimación con la fórmula estándar (RER ${Math.round(rer)} kcal × factor ${factor}). Ajusta según:
<br>• Las <b>kcal reales de tu alimento</b> — vienen en el saco y varían bastante entre marcas.
<br>• Su <b>condición corporal</b>: deberías palpar las costillas sin apretar y verle cintura desde arriba. Si no, baja la ración un 10%.
<br>• Los <b>premios</b> no deben superar el 10% del total diario.
<br><br>Pésalo cada 2–4 semanas para verificar que va bien.`;
  },

  /* ══════ ¿PUEDE COMER? — guía toxicológica canina ══════
     Niveles: peligro (tóxico, urgencia) · precaucion (riesgo o solo en poca cantidad) · seguro */
  FOODS:[
    // ── TÓXICOS ──
    {n:'Chocolate', k:['chocolate','cacao','bombon','brownie'], lvl:'peligro', ico:'🍫',
     w:'Contiene teobromina, que el perro no metaboliza. Mientras más amargo, más tóxico: el chocolate negro y el cacao puro son los peores; el blanco casi no tiene.',
     s:'Vómitos, agitación, temblores, taquicardia, convulsiones. Aparecen entre 2 y 12 h.', urg:true},
    {n:'Xilitol (edulcorante)', k:['xilitol','xylitol','endulzante','edulcorante','chicle','sin azucar'], lvl:'peligro', ico:'🍬',
     w:'El más peligroso de todos y el menos conocido. Está en chicles, caramelos sin azúcar, algunas mantequillas de maní y pastas dentales. Una cantidad mínima provoca caída brusca de azúcar y falla hepática.',
     s:'Debilidad, tambaleo, vómitos y convulsiones en 15–60 min.', urg:true},
    {n:'Uvas y pasas', k:['uva','uvas','pasa','pasas','parra'], lvl:'peligro', ico:'🍇',
     w:'Pueden causar falla renal aguda. No se conoce la dosis segura: hay perros afectados con muy pocas unidades y otros que toleran más, así que se consideran tóxicas siempre.',
     s:'Vómitos, decaimiento, deja de orinar. El daño renal puede tardar 24–72 h.', urg:true},
    {n:'Cebolla, ajo, puerro y cebollín', k:['cebolla','ajo','puerro','cebollin','ciboulette','chalota'], lvl:'peligro', ico:'🧅',
     w:'Destruyen los glóbulos rojos y provocan anemia. Es acumulativo: dosis pequeñas repetidas también dañan. Ojo con caldos, salsas y comida casera condimentada.',
     s:'Debilidad, encías pálidas, orina oscura, respiración agitada (a los 1–5 días).', urg:true},
    {n:'Nuez de macadamia', k:['macadamia'], lvl:'peligro', ico:'🥜',
     w:'Causa un síndrome neurológico característico incluso en cantidades pequeñas.',
     s:'Debilidad en patas traseras, temblores, fiebre y vómitos dentro de 12 h.', urg:true},
    {n:'Alcohol', k:['alcohol','cerveza','vino','trago','licor'], lvl:'peligro', ico:'🍺',
     w:'Muy tóxico incluso en sorbos. También está en la masa cruda con levadura, que fermenta dentro del estómago.',
     s:'Desorientación, vómitos, hipotermia, depresión respiratoria.', urg:true},
    {n:'Masa cruda con levadura', k:['masa','levadura','pan crudo'], lvl:'peligro', ico:'🥖',
     w:'Sigue fermentando en el estómago: se expande y produce alcohol. Riesgo de torsión gástrica.',
     s:'Abdomen hinchado y duro, arcadas sin vomitar, dolor. Es una urgencia.', urg:true},
    {n:'Café y bebidas con cafeína', k:['cafe','cafeina','te ','energetica','bebida energetica'], lvl:'peligro', ico:'☕',
     w:'La cafeína es un estimulante cardíaco potente para el perro.',
     s:'Inquietud, taquicardia, temblores, convulsiones.', urg:true},
    {n:'Huesos cocidos', k:['hueso cocido','huesos cocidos','hueso de pollo','huesos'], lvl:'peligro', ico:'🦴',
     w:'Al cocerse se vuelven quebradizos y se astillan. Pueden perforar el esófago o el intestino. Los huesos crudos y grandes son otra cosa, pero igual requieren supervisión.',
     s:'Arcadas, salivación, sangre en heces, dolor abdominal.', urg:true},
    // ── PRECAUCIÓN ──
    {n:'Palta / aguacate', k:['palta','aguacate','avocado'], lvl:'precaucion', ico:'🥑',
     w:'La pulpa en poca cantidad rara vez intoxica al perro (la persina afecta más a aves y otros animales), pero es muy grasa y puede desencadenar pancreatitis. El carozo es el verdadero peligro: obstruye el intestino.',
     s:'Vómitos, diarrea; si tragó el carozo, obstrucción.'},
    {n:'Lácteos (leche, queso)', k:['leche','queso','lacteo','lacteos','yogur','yogurt','crema'], lvl:'precaucion', ico:'🥛',
     w:'La mayoría de los perros adultos son intolerantes a la lactosa. El yogur natural sin azúcar en poca cantidad suele tolerarse; los quesos son muy grasos y salados.',
     s:'Gases, diarrea, malestar abdominal.'},
    {n:'Frutos secos (nueces, almendras)', k:['nuez','nueces','almendra','almendras','mani','pistacho','fruto seco'], lvl:'precaucion', ico:'🌰',
     w:'Muy grasos (riesgo de pancreatitis) y difíciles de digerir; los enteros pueden atragantar. La macadamia es directamente tóxica. Ojo con la mantequilla de maní: revisa que no tenga xilitol.',
     s:'Vómitos, diarrea, dolor abdominal.'},
    {n:'Carozos y semillas (manzana, durazno, cereza)', k:['carozo','cuesco','semilla','semillas','pepa'], lvl:'precaucion', ico:'🍑',
     w:'La fruta es segura, el carozo no: contiene compuestos cianogénicos y sobre todo puede obstruir el intestino. Retíralos siempre.',
     s:'Atragantamiento, vómitos persistentes, obstrucción.'},
    {n:'Sal y snacks salados', k:['sal','salado','papas fritas','snack','cecina','embutido'], lvl:'precaucion', ico:'🧂',
     w:'El exceso de sal causa deshidratación e intoxicación por sodio. Los embutidos suman grasa y conservantes.',
     s:'Sed intensa, vómitos, temblores en casos graves.'},
    {n:'Tomate verde y hojas', k:['tomate','tomates'], lvl:'precaucion', ico:'🍅',
     w:'El tomate bien maduro en poca cantidad es seguro. El verde y las hojas de la planta contienen solanina.',
     s:'Malestar digestivo, letargo.'},
    {n:'Comida grasa y frituras', k:['fritura','frito','grasa','tocino','manteca','asado'], lvl:'precaucion', ico:'🍟',
     w:'Principal desencadenante de pancreatitis, sobre todo en razas predispuestas y perros con sobrepeso. Muy frecuente después de asados y fiestas.',
     s:'Vómitos repetidos, dolor abdominal, postura encorvada, decaimiento.'},
    // ── SEGUROS ──
    {n:'Pan y galletas simples', k:['pan','galleta','galletas','tostada','miga'], lvl:'precaucion', ico:'🍞',
     w:'El pan horneado simple en poca cantidad no es tóxico, pero aporta calorías vacías y puede inflar. Evita los que llevan pasas, chocolate, nueces, ajo o mucha sal, y nunca la masa cruda.',
     s:'Gases, malestar digestivo si come mucho.'},
    {n:'Manzana (sin semillas)', k:['manzana'], lvl:'seguro', ico:'🍎',
     w:'Buena fuente de fibra y vitamina C. Retira semillas y centro.', s:''},
    {n:'Plátano', k:['platano','banana'], lvl:'seguro', ico:'🍌',
     w:'Rico en potasio. Alto en azúcar: en trozos pequeños y ocasional.', s:''},
    {n:'Sandía y melón (sin semillas)', k:['sandia','melon'], lvl:'seguro', ico:'🍉',
     w:'Muy hidratantes, ideales en verano. Sin cáscara ni semillas.', s:''},
    {n:'Arándanos y frutillas', k:['arandano','arandanos','frutilla','frutillas','berries','fresa'], lvl:'seguro', ico:'🫐',
     w:'Antioxidantes, excelentes como premio bajo en calorías.', s:''},
    {n:'Zanahoria', k:['zanahoria'], lvl:'seguro', ico:'🥕',
     w:'Cruda ayuda a la limpieza dental; cocida es más digerible.', s:''},
    {n:'Zapallo / calabaza cocida', k:['zapallo','calabaza','zapallo italiano','camote','batata'], lvl:'seguro', ico:'🎃',
     w:'Excelente para regular la digestión, tanto en diarrea como en estreñimiento. Sin azúcar ni especias.', s:''},
    {n:'Pollo o pavo cocido sin hueso', k:['pollo','pavo','carne blanca'], lvl:'seguro', ico:'🍗',
     w:'Proteína magra ideal. Sin sal, sin condimentos, sin piel y sin huesos.', s:''},
    {n:'Arroz y avena cocidos', k:['arroz','avena','cereal'], lvl:'seguro', ico:'🍚',
     w:'Base de la dieta blanda para malestar digestivo. Bien cocidos y sin sal.', s:''},
    {n:'Huevo cocido', k:['huevo','huevos'], lvl:'seguro', ico:'🥚',
     w:'Proteína completa. Siempre cocido: el crudo trae riesgo de salmonela.', s:''},
    {n:'Salmón y pescado cocido', k:['salmon','pescado','atun','merluza'], lvl:'seguro', ico:'🐟',
     w:'Omega 3 para piel y articulaciones. Cocido, sin espinas y sin sal.', s:''},
    {n:'Poroto verde y pepino', k:['poroto verde','judia','pepino','apio','lechuga'], lvl:'seguro', ico:'🥒',
     w:'Muy bajos en calorías: buenos premios para perros con sobrepeso.', s:''},
  ],
  FOOD_LVL:{
    peligro:   {t:'No puede comerlo', c:'danger', ico:'⛔', txt:'Tóxico'},
    precaucion:{t:'Con precaución',   c:'warn',   ico:'⚠️', txt:'Riesgoso'},
    seguro:    {t:'Sí puede comerlo', c:'ok',     ico:'✅', txt:'Seguro'},
  },
  norm(t){
    return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/[¿?¡!.,;:()"']/g,' ').replace(/\s+/g,' ').trim();
  },
  findFood(q){
    const s=this.norm(q||'');
    if(s.length<2) return null;
    let best=null, bestScore=0;
    for(const f of this.FOODS){
      let score=0;
      for(const k of f.k){
        const kk=this.norm(k);
        if(s===kk){ score=Math.max(score,100); continue; }                    // exacto
        // la consulta contiene la palabra clave completa (con límites de palabra)
        if(new RegExp(`(^|\\s)${kk.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(\\s|$)`).test(s))
          score=Math.max(score, 80+kk.length);
        // la clave empieza con la consulta (búsqueda parcial mientras se escribe)
        else if(s.length>=4 && kk.startsWith(s)) score=Math.max(score, 40+s.length);
      }
      // nombre: solo la parte antes del paréntesis, para no confundir
      // "manzana" con "Carozos y semillas (manzana, durazno…)"
      const base=this.norm(f.n.split('(')[0]);
      if(base===s) score=Math.max(score,100);
      else if(s.length>=4 && base.startsWith(s)) score=Math.max(score,45+s.length);
      if(score>bestScore){ bestScore=score; best=f; }
    }
    return bestScore>=40 ? best : null;
  },
  foodCard(f){
    const L=this.FOOD_LVL[f.lvl];
    const name=this.state.pet?this.state.pet.name:'tu perro';
    return `<div class="food-card ${L.c}">
      <div class="fc-head"><span class="fc-ico">${f.ico}</span>
        <div><p class="fc-verdict">${L.ico} ${L.t}</p><p class="fc-name">${f.n}</p></div></div>
      <p class="fc-why">${f.w}</p>
      ${f.s?`<div class="fc-signs"><b>Señales de alarma:</b> ${f.s}</div>`:''}
      ${f.urg?`<div class="fc-urgent">🚨 Si ${name} ya lo comió, <b>llama al veterinario de inmediato</b>. No esperes a que aparezcan síntomas ni provoques el vómito sin indicación profesional.</div>`:''}
    </div>`;
  },
  searchFood(q){
    const res=document.getElementById('foodResult');
    const f=this.findFood(q||'');
    if(!f){ res.innerHTML = (q||'').trim().length>=2
      ? `<div class="food-card warn"><div class="fc-head"><span class="fc-ico">🤔</span>
         <div><p class="fc-verdict">No lo tengo en la lista</p><p class="fc-name">"${(q||'').slice(0,30)}"</p></div></div>
         <p class="fc-why">Ante la duda, no se lo des. Puedes preguntarle al 🩺 <b>Vet IA</b> o consultar a tu veterinario.</p></div>`
      : '';
      this.renderFoodBrowse(); return; }
    res.innerHTML=this.foodCard(f);
    document.getElementById('foodBrowse').innerHTML='';
  },
  renderFoodBrowse(){
    const el=document.getElementById('foodBrowse'); if(!el) return;
    const grp=(lvl,titulo)=>{
      const items=this.FOODS.filter(f=>f.lvl===lvl);
      return `<h3 class="section-title">${titulo}</h3>
      <div class="food-grid">${items.map(f=>
        `<button class="food-chip ${this.FOOD_LVL[lvl].c}" onclick="App.pickFood('${f.n.replace(/'/g,"\\'")}')">
          <span>${f.ico}</span>${f.n}</button>`).join('')}</div>`;
    };
    el.innerHTML = grp('peligro','⛔ Nunca darle')+grp('precaucion','⚠️ Con precaución')+grp('seguro','✅ Puede comer')
      + `<p class="food-note">Guía informativa de apoyo. Ante ingesta de un tóxico o cualquier síntoma, acude al veterinario: no reemplaza la atención profesional.</p>`;
  },
  pickFood(name){
    const f=this.FOODS.find(x=>x.n===name); if(!f) return;
    document.getElementById('foodQ').value=f.n;
    document.getElementById('foodResult').innerHTML=this.foodCard(f);
    document.getElementById('foodBrowse').innerHTML='';
    window.scrollTo({top:0,behavior:'smooth'});
  },
  renderFood(){
    document.getElementById('foodQ').value='';
    document.getElementById('foodResult').innerHTML='';
    this.renderFoodBrowse();
  },

  /* ══════ ANÁLISIS ACÚSTICO EMOCIONAL ══════
     Basado en literatura de bioacústica canina (Pongrácz et al.; Molnár et al.;
     y el enfoque valencia-arousal de Beyond Discrete Categories, 2025).
     Tres parámetros predicen el estado emocional mejor que la sola clasificación:
       · F0 (tono fundamental): grave = amenaza/territorial · agudo = miedo/juego
       · HNR (tonalidad): tonal = alta carga emocional · ruidoso = agresivo
       · Ritmo (intervalo entre ladridos): rápido = alta activación
     Se mapea a valencia (agradable↔desagradable) y arousal (calma↔excitación). */
  acoustics:{lastBarkTs:0, intervals:[]},
  analyzeAcoustics(samples, sampleRate){
    const N=samples.length;
    // — F0 por autocorrelación (rango canino útil: 150–1800 Hz) —
    let f0=0, best=0;
    const minLag=Math.floor(sampleRate/1800), maxLag=Math.floor(sampleRate/150);
    let e0=0; for(let i=0;i<N;i++) e0+=samples[i]*samples[i];
    if(e0>0.0001){
      for(let lag=minLag;lag<=maxLag&&lag<N;lag++){
        let s=0,e1=0;
        for(let i=0;i<N-lag;i++){ s+=samples[i]*samples[i+lag]; e1+=samples[i+lag]*samples[i+lag]; }
        const norm=s/(Math.sqrt(e0*e1)+1e-9);
        if(norm>best){ best=norm; f0=sampleRate/lag; }
      }
    }
    // — HNR aproximado: la calidad del pico de autocorrelación indica tonalidad —
    const hnr=Math.max(0,Math.min(1,best));
    // — Energía (proxy de intensidad) —
    const rms=Math.sqrt(e0/N);
    // — Ritmo: intervalo desde el ladrido anterior —
    const now=Date.now(), a=this.acoustics;
    let interval=null;
    if(a.lastBarkTs && now-a.lastBarkTs<8000){
      interval=now-a.lastBarkTs;
      a.intervals.push(interval); if(a.intervals.length>8) a.intervals.shift();
    } else a.intervals=[];
    a.lastBarkTs=now;
    const avgInt=a.intervals.length?a.intervals.reduce((x,y)=>x+y,0)/a.intervals.length:null;
    return {f0:Math.round(f0), hnr:+hnr.toFixed(2), rms:+rms.toFixed(4),
            interval:avgInt?Math.round(avgInt):null, burst:a.intervals.length+1};
  },
  // Mapea parámetros acústicos → valencia/arousal → significado probable
  emotionFromAcoustics(ac, type){
    // arousal: sube con tono agudo, ritmo rápido e intensidad
    let arousal=0.5;
    if(ac.f0>0){ arousal += ac.f0>700?0.28 : ac.f0>450?0.12 : -0.18; }
    if(ac.interval!==null){ arousal += ac.interval<400?0.3 : ac.interval<900?0.14 : -0.1; }
    arousal += Math.min(0.2, ac.rms*1.6); // intensidad: aporta, sin dominar
    // valencia: tonal y agudo = positivo · grave y ruidoso = negativo
    let valence=0.5;
    valence += ac.hnr>0.6?0.18 : ac.hnr<0.35?-0.2 : 0;
    if(ac.f0>0) valence += ac.f0>600?0.12 : ac.f0<300?-0.22 : 0;
    if(type==='gruñido') valence-=0.3;
    if(type==='gemido'){ valence-=0.18; arousal-=0.12; }
    if(type==='aullido'){ arousal+=0.08; valence-=0.16; } // aullido: aislamiento/llamado
    valence=+Math.max(0,Math.min(1,valence)).toFixed(2);
    arousal=+Math.max(0,Math.min(1,arousal)).toFixed(2);
    // cuadrantes del modelo circumplejo (valencia × activación)
    let meaning, label;
    const grave = ac.f0>0 && ac.f0<330;
    if(valence<=0.3){                       // valencia muy negativa → amenaza o miedo
      if(type==='gruñido'||grave){ meaning='territorio'; label='Amenaza / defensa'; }
      else if(type==='gemido'){ meaning='dolor'; label='Malestar'; }
      else { meaning='asustado'; label='Miedo'; }
    }
    else if(arousal>=0.62 && valence>0.55){ meaning='emocionado'; label='Excitación positiva'; }
    else if(arousal>=0.62 && valence<=0.5){ meaning= type==='gruñido'?'territorio':'ansioso'; label='Tensión / alerta'; }
    else if(arousal<=0.42 && valence<=0.45){ meaning= type==='gemido'?'dolor':'asustado'; label='Malestar'; }
    else if(arousal<=0.42 && valence>0.55){ meaning='atencion'; label='Calma / demanda suave'; }
    else { // zona media: el tipo de vocalización es la señal más informativa
      if(type==='gemido'){ meaning= valence<0.5?'dolor':'atencion'; label='Demanda / incomodidad'; }
      else if(type==='gruñido'){ meaning='territorio'; label='Advertencia'; }
      else if(type==='aullido'){ meaning='ansioso'; label='Llamado / aislamiento'; }
      else if(arousal>0.55){ meaning= ac.f0>500?'jugar':'salir'; label='Activación moderada'; }
      else { meaning='atencion'; label='Demanda tranquila'; }
    }
    return {valence, arousal, meaning, label};
  },
  acousticSummary(ac){
    const p=[];
    if(ac.f0) p.push(`${ac.f0} Hz ${ac.f0>600?'(agudo)':ac.f0<300?'(grave)':''}`.trim());
    if(ac.hnr) p.push(ac.hnr>0.6?'tonal':ac.hnr<0.35?'ruidoso':'mixto');
    if(ac.interval) p.push(`ráfaga de ${ac.burst} cada ${(ac.interval/1000).toFixed(1)} s`);
    return p.join(' · ');
  },

  /* ══════ CUENTA · SUSCRIPCIÓN · PAGO ══════
     La app NO almacena datos de tarjeta: solo el token y los últimos 4 dígitos
     que devuelve la pasarela (Webpay/Mercado Pago/Stripe). */
  PLANS:{
    free:     {name:'Gratuito', clp:0,    ico:'🐾', pets:1},
    premium:  {name:'Premium',  clp:4990, ico:'⭐', pets:1},
    familiar: {name:'Familiar', clp:8990, ico:'👨‍👩‍👧', pets:3},
  },
  EXTRA_CLP:4700, EXTRA_USD:5,
  account(){
    if(!this.state.account) this.state.account={
      name:'Tomás Callealta', email:'t.callealta@gmail.com',
      card:null, autoRenew:true, since:Date.now(), invoices:[]
    };
    return this.state.account;
  },
  planTotalCLP(){
    const p=this.PLANS[this.state.plan]||this.PLANS.free;
    return p.clp + (this.state.plan==='free'?0:(this.state.extraPets||0)*this.EXTRA_CLP);
  },
  nextChargeDate(){
    const a=this.account();
    if(a.nextCharge) return a.nextCharge;
    const d=new Date(); d.setMonth(d.getMonth()+1);
    return d.getTime();
  },
  renderAccount(){
    const a=this.account(), plan=this.PLANS[this.state.plan]||this.PLANS.free;
    const paid=this.state.plan!=='free';
    document.getElementById('accName').textContent=a.name;
    document.getElementById('accMail').textContent=a.email;
    document.getElementById('accAvatar').textContent=(a.name||'?').trim()[0].toUpperCase();
    const pill=document.getElementById('accPlanPill');
    pill.textContent=plan.name; pill.className='acc-plan-pill'+(paid?' paid':'');

    // suscripción
    const total=this.planTotalCLP();
    const extra=this.state.extraPets||0;
    const nd=new Date(this.nextChargeDate());
    document.getElementById('subCard').className='sub-card'+(paid?' active':'');
    document.getElementById('subCard').innerHTML=`
      <div class="sub-top"><span class="st-ico">${plan.ico}</span>
        <div><p class="sub-plan">${plan.name}</p>
        <p class="sub-price">${paid?`CLP $${total.toLocaleString('es-CL')} / mes`:'Sin costo · 1 mascota · 20 grabaciones al mes'}</p></div>
      </div>
      <div class="sub-rows">
        <div class="sub-row"><span>Mascotas incluidas</span><span>${plan.pets}${extra?` + ${extra} extra`:''}</span></div>
        ${extra?`<div class="sub-row"><span>Mascotas adicionales</span><span>${extra} × USD $${this.EXTRA_USD} (CLP $${(extra*this.EXTRA_CLP).toLocaleString('es-CL')})</span></div>`:''}
        <div class="sub-row"><span>Estado</span><span style="color:${paid?'#177E72':'var(--sub)'}">${paid?'● Activa':'○ Plan gratuito'}</span></div>
        ${paid?`<div class="sub-row"><span>${a.autoRenew?'Se renueva el':'Vence el'}</span><span>${nd.toLocaleDateString('es-CL',{day:'2-digit',month:'long',year:'numeric'})}</span></div>`:''}
      </div>
      ${paid?`<div class="renew-box">
        <span style="font-size:22px">🔄</span>
        <div class="rb-txt"><b>Renovación automática</b>
        <small>${a.autoRenew?`Se cobrará CLP $${total.toLocaleString('es-CL')} el ${nd.toLocaleDateString('es-CL')} y cada mes.`:'Tu plan terminará en la fecha indicada y no se cobrará de nuevo.'}</small></div>
        <label class="switch"><input type="checkbox" id="renewTgl" ${a.autoRenew?'checked':''}><span class="slider"></span></label>
      </div>`:`<button class="btn-primary" style="margin-top:14px" onclick="App.go('subscription')">Ver planes ⭐</button>`}`;
    const tgl=document.getElementById('renewTgl');
    if(tgl) tgl.onchange=()=>{
      a.autoRenew=tgl.checked; this.save(); this.renderAccount();
      this.toast(tgl.checked?'Renovación automática activada 🔄':'Renovación automática desactivada');
    };

    // método de pago
    const pm=document.getElementById('payMethod');
    pm.innerHTML = a.card ? `
      <div class="card-chip">
        <div class="cc-top"><span class="cc-brand">${a.card.brand}</span><span style="font-size:20px">${a.card.ico}</span></div>
        <div class="cc-num">•••• •••• •••• ${a.card.last4}</div>
        <div class="cc-bot">
          <div><p class="cc-lbl">Titular</p><p class="cc-val">${a.card.holder}</p></div>
          <div><p class="cc-lbl">Vence</p><p class="cc-val">${a.card.exp}</p></div>
        </div>
      </div>
      <div class="cc-actions">
        <button onclick="App.openPaySheet()">Cambiar tarjeta</button>
        <button onclick="App.removeCard()">Eliminar</button>
      </div>`
      : `<div class="no-card"><p>💳 No hay un método de pago asociado</p>
         <button class="btn-primary" onclick="App.openPaySheet()">Agregar método de pago</button></div>`;

    // facturación
    const bl=document.getElementById('billingList');
    bl.innerHTML = a.invoices.length ? a.invoices.slice().reverse().map(i=>`
      <div class="bill-row">
        <span style="font-size:20px">🧾</span>
        <div class="br-info"><p class="br-date">${new Date(i.ts).toLocaleDateString('es-CL',{day:'2-digit',month:'short',year:'numeric'})}</p>
        <p class="br-desc">${i.desc}</p></div>
        <div style="text-align:right"><p class="br-amt">$${i.clp.toLocaleString('es-CL')}</p>
        <span class="bill-badge">Pagado</span></div>
      </div>`).join('') : this.emptyIllu('Aún no hay cobros.<br>Tu historial aparecerá aquí.');
  },
  openPaySheet(){ document.getElementById('payBackdrop').hidden=false; document.getElementById('paySheet').hidden=false; },
  closePaySheet(){ document.getElementById('payBackdrop').hidden=true; document.getElementById('paySheet').hidden=true; },
  linkCard(gateway){
    this.closePaySheet();
    const names={webpay:'Webpay Plus',mercadopago:'Mercado Pago',stripe:'Stripe'};
    this.toast(`Abriendo ${names[gateway]}… 🔒`);
    setTimeout(()=>{
      // DEMO: en producción aquí vuelve el token + últimos 4 dígitos desde la pasarela
      const brands=[['Visa','💠'],['Mastercard','🔴'],['American Express','🟦']];
      const [brand,ico]=brands[Math.floor(Math.random()*brands.length)];
      const a=this.account();
      a.card={gateway, brand, ico, last4:String(Math.floor(1000+Math.random()*9000)),
        holder:a.name.toUpperCase(), exp:`${String(1+Math.floor(Math.random()*12)).padStart(2,'0')}/2${8+Math.floor(Math.random()*2)}`,
        token:'tok_demo_'+Math.random().toString(36).slice(2,10)};
      this.save(); this.renderAccount();
      this.toast(`Tarjeta ${brand} •••• ${a.card.last4} asociada ✅`);
      this.confetti();
      if(this._pendingPlan){ const p=this._pendingPlan; this._pendingPlan=null; setTimeout(()=>this.subscribe(p),700); }
    },900);
  },
  removeCard(){
    if(!confirm('¿Eliminar el método de pago? Si tienes una suscripción activa, no podrá renovarse.')) return;
    const a=this.account(); a.card=null; a.autoRenew=false; this.save(); this.renderAccount();
    this.toast('Método de pago eliminado');
  },
  cancelSub(){
    if(this.state.plan==='free'){ this.toast('No tienes una suscripción activa'); return; }
    if(!confirm('¿Cancelar tu suscripción?\n\nMantendrás el acceso hasta el final del período ya pagado y luego volverás al plan Gratuito.')) return;
    const a=this.account(); a.autoRenew=false; a.canceledAt=Date.now(); this.save();
    this.renderAccount();
    this.toast('Suscripción cancelada. Tienes acceso hasta el fin del período.');
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
    {k:['en celo','celo','castr','esteriliz','preñ','monta','cruzar'],t:'reproductivo',
     r:p=>`La esterilización previene tumores mamarios, piometra y problemas prostáticos, y reduce conductas de vagabundeo y marcaje.
<br><br>El momento óptimo varía según tamaño y sexo — en razas grandes suele recomendarse esperar al cierre de las placas de crecimiento. Conversa el mejor timing para ${p.name} con tu veterinario.`},
    {k:['cuanto come','cuanta comida','cuanta comida le doy','racion','ración','cuanto debe comer','cuanto le doy','gramos','porcion','cuanto darle','cuanto tiene que comer'],t:'ración',
     r:p=>App.rationAdvice(p)},
    {k:['cachorro','puppy','bebe','recien nacido','meses de vida'],t:'cachorro',
     r:p=>`<b>Claves de los primeros meses:</b>
<br><br>• <b>Vacunas:</b> séxtuple desde las 6–8 semanas con refuerzos cada 21 días hasta las 16 semanas; antirrábica a los 3–4 meses. Hasta completar el esquema, evita plazas y contacto con perros desconocidos.
<br>• <b>Desparasitación:</b> cada 15 días hasta los 3 meses, luego mensual hasta los 6.
<br>• <b>Socialización:</b> la ventana crítica va de las 3 a las 14 semanas. Exponerlo con calma a ruidos, personas, superficies y otros perros sanos previene miedos de adulto.
<br>• <b>Mordidas:</b> normal en la dentición. Si muerde fuerte, detén el juego unos segundos: aprende a inhibir la fuerza.
<br>• <b>Comidas:</b> 3–4 veces al día hasta los 6 meses.
<br><br>Pregúntame "cuánta comida" y te calculo su ración según peso.`},
    {k:['calor','golpe de calor','hace mucho calor','mucho calor','hace calor','verano','asfalto','deshidrat','sol fuerte'],t:'calor',urgent:['jadea sin parar','colaps','no responde'],
     r:p=>`Los perros no sudan: solo regulan por jadeo, así que el <b>golpe de calor</b> es una urgencia real y frecuente.
<br><br>• <b>Nunca</b> lo dejes en el auto, ni con ventanas abiertas: en 10 minutos el interior es letal.
<br>• Pasea temprano o al atardecer. Prueba el asfalto con el dorso de tu mano 7 segundos: si te quema, le quema las almohadillas.
<br>• Señales de alerta: jadeo extremo, babeo espeso, encías rojo intenso, tambaleo, vómitos.
<br>• <b>Primeros auxilios:</b> a la sombra, agua fresca (no helada) en patas, ingle y cuello, y al veterinario de inmediato.
${p.breed&&/bulldog|pug|boxer|shih|pekines|braquic/i.test(p.breed)?`<br><br>⚠️ ${p.breed} es una raza braquicéfala (hocico corto): tienen mucho más riesgo de golpe de calor. Extrema precauciones.`:''}`},
    {k:['ejercicio','pasear','paseo','cuanto caminar','actividad'],t:'ejercicio',
     r:p=>{const age=+p.age||3;
      const base = age<1?'2–3 salidas cortas al día (regla orientativa: 5 minutos por mes de edad, dos veces al día, para no dañar sus articulaciones en crecimiento)'
        : age>=8?'2 paseos diarios de 20–30 min, suaves y a su ritmo'
        : (p.activity==='alto'?'60–90 min diarios repartidos, sumando juego y olfateo':'45–60 min diarios en 2 salidas');
      return `Para ${p.name}${p.age?` (${p.age} años`:''}${p.activity?`, actividad ${p.activity})`:p.age?')':''}: <b>${base}</b>.
<br><br>El <b>olfateo</b> cansa más que correr: 15 minutos husmeando equivalen a un buen rato de ejercicio físico y bajan la ansiedad. Deja que huela.
<br><br>Señales de que le falta ejercicio: destrucción, ladrido excesivo, inquietud nocturna, exceso de energía en casa.`;}},
    {k:['banar','bañar','baño','bano','champu','shampoo','higiene'],t:'baño',
     r:p=>`<b>Frecuencia:</b> cada 3–6 semanas en general. Bañarlo de más elimina la capa de grasa protectora y reseca la piel.
<br><br>• Usa <b>siempre</b> champú para perros: el humano tiene un pH que les daña la piel.
<br>• Agua tibia, secado completo (sobre todo en pliegues y orejas) para evitar hongos.
<br>• Uñas: cada 3–4 semanas si no se desgastan solas. Si escuchas el "clic" al caminar, están largas.
<br>• Dientes: cepillado idealmente diario con pasta canina.
<br>• Orejas: revisar semanalmente; si hay mal olor o secreción oscura, consulta.`},
    {k:['come pasto','comer pasto','come tierra','pica '],t:'pica',
     r:p=>`Comer pasto es <b>común y no siempre patológico</b>: puede ser conducta normal, aburrimiento o intento de aliviar malestar.
<br><br><b>Preocúpate si:</b> lo hace compulsivamente, vomita después de forma repetida, o come tierra/piedras (podría indicar déficit nutricional, anemia o pica).
<br><br>⚠️ El riesgo mayor es el <b>pasto fumigado</b> con herbicidas o pesticidas. Evita jardines tratados.`},
    {k:['come caca','coprofagia','propia caca','sus heces','excremento','caca','popo'],t:'coprofagia',
     r:p=>`La coprofagia es desagradable pero frecuente. Causas: conducta aprendida de cachorro, dieta poco digestible, aburrimiento, o llamada de atención (si lo retas, refuerzas la conducta).
<br><br><b>Manejo:</b> recoger de inmediato, enriquecer el ambiente, revisar que el alimento cubra sus necesidades, y descartar parásitos o malabsorción con el veterinario.
<br><br>No lo castigues: aumenta el estrés y suele empeorarlo.`},
    {k:['auto','viaje','viajar','avion','marea','transporte'],t:'viajes',
     r:p=>`<b>Mareo en auto:</b> más común en cachorros (el oído interno aún madura). Viaja en ayuno de 4–6 h, con ventana algo abierta y paradas cada 2 h.
<br><br><b>Seguridad:</b> siempre con arnés de seguridad homologado o transportín anclado — nunca suelto ni con la cabeza fuera de la ventana.
<br><br><b>Viajes largos o avión:</b> necesitarás certificado de salud vigente, vacunas al día y, según destino, microchip. Consulta con anticipación los requisitos.`},
    {k:['viejo','anciano','senior','envejec','edad avanzada','artros'],t:'senior',
     r:p=>`${p.age&&+p.age>=7?`Con ${p.age} años, ${p.name} ya está en etapa senior. `:'Un perro se considera senior desde los 7 años (antes en razas grandes). '}Cambios esperables y qué hacer:
<br><br>• <b>Movilidad:</b> artrosis frecuente. Paseos más cortos pero regulares, camas ortopédicas, evitar pisos resbalosos, control de peso.
<br>• <b>Sentidos:</b> puede perder audición o visión; mantén los muebles en su lugar.
<br>• <b>Cognición:</b> desorientación, cambios de sueño o ladrido nocturno pueden ser disfunción cognitiva — hay tratamiento, consúltalo.
<br>• <b>Controles:</b> chequeo veterinario cada 6 meses con exámenes de sangre.
<br><br>📊 Si notas cambios de conducta, la app te los muestra en el perfil emocional y puedes llevar el reporte PDF a la consulta.`},
    {k:['ladra mucho','no para de ladrar','ladrido excesivo','como evitar que ladre'],t:'ladrido',
     r:p=>`Primero identifica <b>la causa</b>, porque el manejo cambia: territorial (ventana/timbre), demanda de atención, alerta, aburrimiento o ansiedad.
<br><br>• <b>Nunca grites</b>: el perro interpreta que lo acompañas.
<br>• Si ladra por atención, ignora por completo hasta que se calle y recién ahí premia el silencio.
<br>• Si es territorial, limita la vista a la calle y refuerza la calma cuando pasa el estímulo.
<br>• Más ejercicio y olfateo reduce el ladrido por energía acumulada.
<br><br>📊 Usa las <b>estadísticas</b> de la app: los horarios de mayor ladrido suelen revelar el gatillo.`},
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
    const sv=this.symptomVerdict();
    return {p, recent:recent.length,
      topEmo: topEmo?this.EMOS[topEmo[0]].label:null,
      tension: total?Math.round((cnt.ansioso+cnt.estresado)/total*100):0,
      pain: recent.filter(e=>(e.meaning||e.pred)==='dolor').length,
      age: this.ageLabel(p), stage: this.lifeStage(p),
      meds: (this.state.meds||[]).filter(m=>this.medIsActive(m)),
      symptoms: (this.state.symptoms||[]).filter(s=>s.ts>=week),
      verdict: sv,
      weight: this.weightTrend(30)};
  },
  renderVet(){
    const c=this.vetContext();
    const ctxEl=document.getElementById('vetCtx');
    if(!c){ ctxEl.textContent='Crea el perfil de tu mascota para respuestas personalizadas.'; return; }
    const p=c.p;
    ctxEl.innerHTML=`🔎 <b>Contexto cargado:</b> ${p.name}${p.breed?', '+p.breed:''}, ${c.age} (${c.stage.label})${p.weight?', '+p.weight+' kg':''}${p.neutered==='si'?', esterilizado/a':''} · ${c.recent} eventos esta semana${c.topEmo?' · estado dominante: '+c.topEmo:''}${c.tension?' · tensión '+c.tension+'%':''}${c.meds.length?' · 💊 '+c.meds.map(m=>m.name).join(', '):''}${c.symptoms.length?' · 🤒 '+c.symptoms.length+' malestar(es) esta semana':''}`;
    if(!this.vetHistory.length){
      this.vetSay('bot',`¡Hola! Soy el asistente veterinario de <b>${p.name}</b> 🩺<br><br>Tengo cargados su raza, edad, peso, historial médico, vacunas y su comportamiento reciente. Pregúntame lo que necesites — por ejemplo síntomas que notaste, dudas de alimentación, vacunas o conducta.`,true);
    }
    const sug=['¿Puede comer chocolate?','¿Puede comer palta?','¿Cuándo toca la próxima vacuna?','Se rasca mucho',
      '¿Cada cuánto desparasitar?','Lleva dos días jadeando','¿Cuánto debe comer al día?','¿Puede comer huesos?'];
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
    if(/(puede|pueden|dar|darle|doy|damos|comer|come|comio|comió|trago|tragó|ingiri|mordio|mordió|toxic|veneno|malo|mala|permitido|prohibid|peligroso)/.test(this.norm(s))){
      const f=this.findFood(s);
      if(f){
        const L=this.FOOD_LVL[f.lvl];
        return `${L.ico} <b>${L.t}: ${f.n}</b><br><br>${f.w}`
          + (f.s?`<br><br><b>Señales de alarma:</b> ${f.s}`:'')
          + (f.urg?`<br><br>🚨 <b>Si ya lo comió, contacta al veterinario de inmediato.</b> No provoques el vómito sin indicación profesional.`:'')
          + `<br><br>💡 Revisa más alimentos en 🍽️ <b>¿Puede comer?</b>`;
      }
    }
    // gana la coincidencia más específica (palabra clave más larga), no la primera del listado
    let hit=null, hitLen=0;
    for(const e of this.VET_KB){
      for(const k of e.k){
        if(s.includes(k) && k.length>hitLen){ hit=e; hitLen=k.length; }
      }
    }
    if(!hit){
      const c=this.vetContext();
      return `No tengo una guía específica para esa consulta, pero puedo orientarte con lo que sé de <b>${p.name}</b>:
<br><br>• ${p.breed||'Raza no registrada'}, ${c.age} (${c.stage.label})${p.weight?`, ${p.weight} kg`:''}
<br>• ${c.recent} vocalizaciones esta semana${c.topEmo?`, estado dominante <b>${c.topEmo}</b>`:''}
${c.pain?`<br>• ⚠️ ${c.pain} evento(s) asociados a posible dolor`:''}
${c.symptoms.length?`<br>• 🤒 Malestares registrados: ${[...new Set(c.symptoms.map(s=>this.SYMPTOMS[s.type].l))].join(', ')}`:''}
${c.meds.length?`<br>• 💊 En tratamiento: ${c.meds.map(m=>`${m.name}${m.dose?' ('+m.dose+')':''}`).join(', ')}`:''}
${c.weight&&Math.abs(c.weight.pct)>=5?`<br>• ⚖️ El peso ${c.weight.diff>0?'subió':'bajó'} ${Math.abs(c.weight.pct)}% en 30 días`:''}
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
      }).join('') : this.emptyIllu(empty);
    };
    render(all.filter(v=>this.VAC_TYPES[v.type]),'vacList','Sin vacunas registradas.');
    render(all.filter(v=>this.TREAT_TYPES[v.type]),'treatList','Sin tratamientos registrados.');
    // accesos rápidos con su estado actual
    const act=(this.state.meds||[]).filter(m=>this.medStatus(m)==='active').length;
    const sv=this.symptomVerdict();
    const w=(this.state.weights||[]).slice().sort((a,b)=>a.date.localeCompare(b.date)).pop();
    const meals=this.mealsOf();
    const set=(id,txt)=>{ const e=document.getElementById(id); if(e) e.textContent=txt; };
    set('hlMeds', act?`${act} activo${act>1?'s':''}`:'ninguno');
    set('hlSym', sv.level==='ok'?'sin novedad':sv.level==='watch'?'en observación':sv.level==='vet'?'ver al vet':'urgente');
    set('hlW', w?`${w.kg} kg`:'sin datos');
    set('hlMeals', meals.times.length?`${meals.times.length}/día`:'sin definir');
    this.renderVetCard();
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
    const healthData=(this.state.symptoms||[]).filter(s=>s.ts>=since).length
      + (this.state.meds||[]).length + (this.state.weights||[]).length;
    if(evs.length<3 && healthData<2){ this.toast('Necesitas más registros (eventos, síntomas, peso o medicamentos) para un reporte útil 📊'); return; }
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
    // ── salud diaria: malestares, tratamientos, peso y alimentación ──
    const syms=(this.state.symptoms||[]).filter(s=>s.ts>=since).sort((a,b)=>a.ts-b.ts);
    const symRows=syms.map(s=>`<tr><td>${new Date(s.ts).toLocaleString('es-CL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td>
      <td>${this.SYMPTOMS[s.type].l}</td><td>${s.sev}</td><td>${(s.note||'—').replace(/</g,'&lt;')}</td></tr>`).join('');
    const medsP=(this.state.meds||[]).filter(m=>this.medEndKey(m)>=this.dateKey(since));
    const medRows=medsP.map(m=>{ const pr=this.medProgress(m);
      return `<tr><td>${m.name}</td><td>${m.dose||'—'}</td><td>${m.times.length}×/día (${m.times.join(', ')})</td>
      <td>${new Date(m.start+'T12:00:00').toLocaleDateString('es-CL')} — ${new Date(this.medEndKey(m)+'T12:00:00').toLocaleDateString('es-CL')}</td>
      <td>${pr.given}/${pr.total} (${pr.pct}%)</td></tr>`; }).join('');
    const wList=(this.state.weights||[]).slice().sort((a,b)=>a.date.localeCompare(b.date)).filter(w=>w.date>=this.dateKey(since));
    const wRows=wList.map((w,i)=>{ const pv=wList[i-1];
      return `<tr><td>${new Date(w.date+'T12:00:00').toLocaleDateString('es-CL')}</td><td>${w.kg} kg</td>
      <td>${pv?`${w.kg-pv.kg>0?'+':''}${(w.kg-pv.kg).toFixed(2)} kg`:'—'}</td></tr>`; }).join('');
    const wTrend=this.weightTrend(days);
    const ml=this.mealsOf();
    const adher=(()=>{ if(!ml.times.length) return null;
      let tot=0, ok=0;
      for(let i=0;i<days;i++){ const k=this.addDays(this.dateKey(),-i); if(k<this.dateKey(since)) break;
        const lg=ml.log[k]; if(!lg) continue; tot+=ml.times.length; ok+=ml.times.filter(t=>lg[t]).length; }
      return tot?Math.round(ok/tot*100):null; })();
    const mealLine=ml.times.length
      ? `${ml.times.length} comidas diarias a las ${ml.times.join(', ')}${ml.grams?` · ${ml.grams} g por toma (${ml.grams*ml.times.length} g/día)`:''}${adher!==null?` · cumplimiento registrado: ${adher}%`:''}.`
      : '';
    // hallazgos derivados de la salud diaria
    const sv=this.symptomVerdict();
    if(sv.level==='urgent') find.unshift(['alta',`Signos de urgencia en las últimas 24 h: ${sv.reasons.join(' ')}`]);
    else if(sv.level==='vet') find.push(['alta',`Malestares con criterio de consulta: ${sv.reasons.join(' ')}`]);
    if(syms.length>=3){
      const cnt={}; syms.forEach(s=>cnt[s.type]=(cnt[s.type]||0)+1);
      const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0];
      find.push(['media',`${syms.length} malestares registrados en el período; el más frecuente fue ${this.SYMPTOMS[top[0]].l} (${top[1]} veces).`]);
    }
    if(wTrend&&Math.abs(wTrend.pct)>=10) find.push(['alta',`Variación de peso del ${wTrend.pct}% en ${wTrend.days} días (${wTrend.from.kg} → ${wTrend.to.kg} kg). Amerita evaluación.`]);
    else if(wTrend&&Math.abs(wTrend.pct)>=5) find.push(['media',`Variación de peso del ${wTrend.pct}% en ${wTrend.days} días.`]);
    medsP.filter(m=>{const pr=this.medProgress(m); return pr.total&&pr.pct<70&&this.medStatus(m)!=='upcoming';})
      .forEach(m=>{ const pr=this.medProgress(m);
        find.push(['media',`Adherencia baja en ${m.name}: ${pr.given} de ${pr.total} tomas registradas (${pr.pct}%).`]); });
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
<tr><th>Edad</th><td>${this.ageLabel(p)}${p.birth?` (nac. ${new Date(p.birth+'T12:00:00').toLocaleDateString('es-CL')})`:''}</td><th>Peso</th><td>${p.weight?p.weight+' kg':'—'}</td></tr>
<tr><th>Etapa vital</th><td>${this.lifeStage(p).label}</td><th>Esterilizado</th><td>${p.neutered==='si'?'Sí':p.neutered==='no'?'No':'—'}</td></tr>
<tr><th>Sexo</th><td>${p.sex||'—'}</td><th>Actividad</th><td>${p.activity||'—'}</td></tr>
${p.medical?`<tr><th>Historial médico</th><td colspan="3">${p.medical}</td></tr>`:''}</table>

${symRows?`<h2>Malestares registrados en el período</h2>
<table><tr><th>Fecha y hora</th><th>Signo</th><th>Intensidad</th><th>Nota del tutor</th></tr>${symRows}</table>`:''}

${medRows?`<h2>Tratamientos del período</h2>
<table><tr><th>Medicamento</th><th>Dosis</th><th>Pauta</th><th>Período</th><th>Adherencia</th></tr>${medRows}</table>`:''}

${wRows?`<h2>Curva de peso</h2>
<table><tr><th>Fecha</th><th>Peso</th><th>Variación</th></tr>${wRows}</table>
${wTrend?`<p style="font-size:12px;color:#6b5b53;margin-top:6px">Variación de ${wTrend.diff>0?'+':''}${wTrend.diff} kg (${wTrend.pct}%) en los últimos ${wTrend.days} días.</p>`:''}`:''}

${mealLine?`<h2>Rutina de alimentación</h2><p style="font-size:13px">${mealLine}</p>`:''}

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
      this.askNotifPermission();
      if(!this.listening) this.toggleListen();
      this.toast('Modo ausencia activado 🚪 El micrófono queda ENCENDIDO grabando en segundo plano.');
      // aviso persistente: el micrófono sigue abierto aunque cambies de pestaña
      setTimeout(()=>this.notify('🔴 Micrófono encendido — Modo ausencia',
        `DogTalk está escuchando a ${this.state.pet?this.state.pet.name:'tu perro'}. No cierres esta pestaña.`), 800);
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

  /* ══════════ WRAPPED ANUAL ══════════ */
  wr:{i:0, timer:null, slides:[], paused:false},

  /* --- cálculo del año --- */
  wrappedData(){
    const p=this.state.pet; if(!p) return null;
    const year=new Date().getFullYear();
    const all=(this.state.events||[]).slice().sort((a,b)=>a.ts-b.ts);
    let evs=all.filter(e=>new Date(e.ts).getFullYear()===year);
    let scope='year';
    if(!evs.length && all.length){ evs=all; scope='all'; }
    const d={year, scope, name:p.name, breed:p.breed, photo:p.photo, evs, total:evs.length};

    const byType={}, byMeaning={}, byDate={}, hours=Array(24).fill(0);
    evs.forEach(e=>{
      byType[e.type]=(byType[e.type]||0)+1;
      const m=e.meaning||e.pred; if(m) byMeaning[m]=(byMeaning[m]||0)+1;
      const dt=new Date(e.ts), key=dt.toDateString();
      byDate[key]=(byDate[key]||0)+1;
      hours[dt.getHours()]++;
    });
    const sortD=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]);
    d.types=sortD(byType); d.meanings=sortD(byMeaning);
    d.topType=d.types[0]?d.types[0][0]:null;
    d.topMeaning=d.meanings[0]?d.meanings[0][0]:null;
    d.hours=hours; d.peakHour=hours.indexOf(Math.max(...hours,0));
    d.daysTracked=Object.keys(byDate).length;
    const td=sortD(byDate)[0];
    d.topDay=td?{date:new Date(td[0]), n:td[1]}:null;
    d.first=evs.length?new Date(evs[0].ts):null;
    d.night=evs.filter(e=>{const h=new Date(e.ts).getHours(); return h>=23||h<6;}).length;
    d.nightPct=d.total?Math.round(d.night/d.total*100):0;
    d.perDay=d.daysTracked?(d.total/d.daysTracked):0;
    d.confirmed=evs.filter(e=>e.meaning).length;
    const wp=evs.filter(e=>e.meaning&&e.pred);
    d.accuracy=wp.length>=3?Math.round(wp.filter(e=>e.meaning===e.pred).length/wp.length*100):null;
    // racha más larga de días consecutivos con registro
    const keys=Object.keys(byDate).map(k=>new Date(k).setHours(0,0,0,0)).sort((a,b)=>a-b);
    let best=keys.length?1:0, run=1;
    for(let i=1;i<keys.length;i++){ run=(keys[i]-keys[i-1]===864e5)?run+1:1; if(run>best)best=run; }
    d.streak=best;
    // emociones del período
    const ec={}; Object.keys(this.EMOS).forEach(k=>ec[k]=0);
    evs.forEach(e=>{ const k=this.emoOf(e); if(k) ec[k]++; });
    // "relajado" se infiere igual que en el dashboard: jornadas de baja actividad
    ec.relajado=Object.values(byDate).filter(n=>n<=Math.max(1,d.perDay*0.4)).length;
    d.emos=Object.entries(ec).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
    d.emoTotal=d.emos.reduce((a,b)=>a+b[1],0);
    d.topEmo=d.emos[0]?d.emos[0][0]:null;
    d.topEmoPct=d.emoTotal?Math.round(d.emos[0][1]/d.emoTotal*100):0;
    // salud del año
    const inYear=s=>s&&new Date(s).getFullYear()===year;
    d.vaccines=(this.state.vaccines||[]).filter(v=>scope==='all'||inYear(v.date)).length;
    d.vacTypes=[...new Set((this.state.vaccines||[]).filter(v=>scope==='all'||inYear(v.date)).map(v=>v.type))];
    d.carnet=(this.state.carnet||[]).length;
    d.pain=byMeaning.dolor||0;
    d.persona=this.wrappedPersona(d);
    return d;
  },

  wrappedPersona(d){
    const typePct=t=>{const r=d.types.find(x=>x[0]===t); return d.total&&r?Math.round(r[1]/d.total*100):0;};
    if(typePct('aullido')>=30) return {emo:'🌙', name:'El Cantante de Medianoche',
      txt:`El ${typePct('aullido')}% de lo que dijo ${d.name} fueron aullidos. Lo suyo no es hablar: es interpretar.`};
    if(d.nightPct>=30) return {emo:'🦉', name:'El Filósofo Nocturno',
      txt:`El ${d.nightPct}% de sus sonidos ocurrió entre las 23:00 y las 6:00. Piensa mejor de noche.`};
    return {
      territorio:{emo:'🛡️', name:'El Guardián',
        txt:`Nadie pasó por la puerta sin que ${d.name} lo anunciara primero. Servicio de seguridad incluido.`},
      jugar:{emo:'🎾', name:'El Eterno Cachorro',
        txt:`Da lo mismo lo que diga el carnet: lo que más pidió ${d.name} este año fue jugar.`},
      emocionado:{emo:'🎉', name:'El Entusiasta',
        txt:`Para ${d.name} todo es la mejor noticia del día. Y vuelve a serlo mañana.`},
      hambre:{emo:'🍖', name:'El Negociador Profesional',
        txt:`${d.name} tiene un solo tema de conversación y lo defiende con una insistencia admirable.`},
      salir:{emo:'🧭', name:'El Explorador',
        txt:`La puerta fue su obsesión del año: afuera siempre está pasando algo mejor.`},
      atencion:{emo:'🥺', name:'El Corazón Pegajoso',
        txt:`Lo que más pidió ${d.name} no fue comida ni paseo. Fuiste tú.`},
      ansioso:{emo:'💗', name:'El Alma Sensible',
        txt:`${d.name} siente todo el doble. Este año te lo dijo muchas veces, y lo escuchaste.`},
      asustado:{emo:'💗', name:'El Alma Sensible',
        txt:`${d.name} siente todo el doble. Este año te lo dijo muchas veces, y lo escuchaste.`},
      dolor:{emo:'🩺', name:'El Paciente Valiente',
        txt:`${d.name} avisó cuando algo le molestaba. Haberlo escuchado a tiempo fue lo más importante del año.`},
    }[d.topMeaning] || {emo:'🐾', name:'El Misterioso',
      txt:`${d.name} todavía guarda secretos. Vamos a descifrarlos el próximo año.`};
  },

  /* --- armado de las tarjetas --- */
  wrappedSlides(d){
    const n=d.name, S=[];
    const nf=v=>v.toLocaleString('es-CL');
    const fecha=dt=>dt.toLocaleDateString('es-CL',{day:'numeric',month:'long'});
    const diaSem=dt=>dt.toLocaleDateString('es-CL',{weekday:'long'});
    const per=d.scope==='year'?`en ${d.year}`:'desde que se conocieron';
    const avatar=d.photo?`<img src="${d.photo}" alt="">`:'🐶';

    S.push({bg:'g1', html:`<div class="wr-in wr-center">
      <div class="wr-avatar">${avatar}</div>
      <p class="wr-kicker">DogTalk AI · Wrapped</p>
      <h2 class="wr-hero">El ${d.year}<br>de ${n}</h2>
      <p class="wr-sub">Un año escuchando lo que quiso decirte.</p>
      <p class="wr-hint">Toca para avanzar · mantén presionado para pausar</p>
    </div>`});

    S.push({bg:'g2', html:`<div class="wr-in">
      <p class="wr-kicker">Se hicieron entender</p>
      <p class="wr-big">${nf(d.total)}</p>
      <h3 class="wr-title">sonidos interpretados</h3>
      <p class="wr-sub">A lo largo de <b>${d.daysTracked} día${d.daysTracked===1?'':'s'}</b> de registro, un promedio de <b>${d.perDay.toFixed(1)}</b> al día.</p>
      ${d.first?`<p class="wr-foot-note">El primero fue el ${fecha(d.first)}. Desde ahí no paró.</p>`:''}
    </div>`});

    if(d.types.length){
      const max=d.types[0][1];
      S.push({bg:'g3', html:`<div class="wr-in">
        <p class="wr-kicker">Su idioma</p>
        <h3 class="wr-title">${n} habla en ${SOUND_TYPES[d.topType].label.toLowerCase()}s</h3>
        <div class="wr-bars2">${d.types.map(([t,v])=>`
          <div class="wr-b2"><span class="wr-b2l">${SOUND_TYPES[t].emoji} ${SOUND_TYPES[t].label}</span>
          <div class="wr-b2t"><i style="--w:${Math.round(v/max*100)}%"></i></div>
          <span class="wr-b2n">${Math.round(v/d.total*100)}%</span></div>`).join('')}</div>
        <p class="wr-sub">${d.types.length>1
          ? `Cada sonido tiene su intención: el ladrido reclama, el gemido pide, el aullido llama a distancia.`
          : `Todavía no lo has escuchado en otros registros. El aullido y el gemido dicen cosas muy distintas.`}</p>
      </div>`});
    }

    if(d.meanings.length){
      const top=d.meanings.slice(0,3), max=top[0][1];
      S.push({bg:'g4', html:`<div class="wr-in">
        <p class="wr-kicker">Lo que más te pidió</p>
        <h3 class="wr-title">${MEANINGS[d.topMeaning].emoji} ${MEANINGS[d.topMeaning].label}</h3>
        <p class="wr-sub2">${Math.round(d.meanings[0][1]/d.total*100)}% de todo lo que dijo ${per}</p>
        <div class="wr-rank">${top.map(([m,v],i)=>`
          <div class="wr-rk"><span class="wr-rkn">${i+1}</span>
          <span class="wr-rkl">${MEANINGS[m].emoji} ${MEANINGS[m].label}</span>
          <div class="wr-b2t"><i style="--w:${Math.round(v/max*100)}%"></i></div>
          <span class="wr-b2n">${v}</span></div>`).join('')}</div>
      </div>`});
    }

    const hMax=Math.max(...d.hours,1);
    const ph=d.peakHour;
    const franja=ph<6?'de madrugada':ph<12?'en la mañana':ph<19?'en la tarde':'en la noche';
    S.push({bg:'g5', html:`<div class="wr-in">
      <p class="wr-kicker">Su hora punta</p>
      <p class="wr-big">${String(ph).padStart(2,'0')}:00</p>
      <h3 class="wr-title">es cuando más habla</h3>
      <div class="wr-hours">${d.hours.map((v,i)=>
        `<i class="${i===ph?'pk':''}" style="--h:${Math.max(4,Math.round(v/hMax*100))}%"></i>`).join('')}</div>
      <p class="wr-sub">${n} se expresa sobre todo ${franja}.${d.nightPct>=15?` Y un ${d.nightPct}% de sus sonidos ocurrió entre las 23:00 y las 6:00, con la casa durmiendo.`:''}</p>
    </div>`});

    if(d.topDay){
      S.push({bg:'g6', html:`<div class="wr-in">
        <p class="wr-kicker">El día más hablador</p>
        <h3 class="wr-hero2">${diaSem(d.topDay.date)}<br>${fecha(d.topDay.date)}</h3>
        <p class="wr-big2">${d.topDay.n} sonidos</p>
        <p class="wr-sub">Ese día ${n} tenía algo importante que decir. ${d.topDay.n>=d.perDay*2?'Habló más del doble de lo habitual.':'Un día movido.'}</p>
      </div>`});
    }

    if(d.topEmo){
      const E=this.EMOS[d.topEmo];
      S.push({bg:'g7', html:`<div class="wr-in wr-center">
        <p class="wr-kicker">Su emoción del año</p>
        <div class="wr-emo">${E.emoji}</div>
        <h3 class="wr-hero2">${E.label}</h3>
        <p class="wr-sub2">${d.topEmoPct}% de su perfil emocional</p>
        <div class="wr-chips">${d.emos.slice(0,4).map(([k,v])=>
          `<span class="wr-chip">${this.EMOS[k].emoji} ${this.EMOS[k].label} ${Math.round(v/d.emoTotal*100)}%</span>`).join('')}</div>
      </div>`});
    }

    S.push({bg:'g8', html:`<div class="wr-in">
      <p class="wr-kicker">Constancia</p>
      <p class="wr-big">${d.streak}</p>
      <h3 class="wr-title">día${d.streak===1?'':'s'} seguidos escuchándolo</h3>
      <div class="wr-mini">
        <div><b>${d.daysTracked}</b><span>días con registro</span></div>
        <div><b>${d.confirmed}</b><span>eventos que confirmaste</span></div>
        ${d.accuracy!==null?`<div><b>${d.accuracy}%</b><span>acertó la IA</span></div>`:''}
      </div>
      <p class="wr-sub">${d.confirmed>0
        ? `Cada vez que corregiste una interpretación, la IA de ${n} aprendió a entenderlo un poco mejor.`
        : `Etiquetar lo que significó cada sonido es lo que hace que la IA aprenda el idioma propio de ${n}.`}</p>
    </div>`});

    if(d.vaccines||d.carnet||d.pain){
      S.push({bg:'g9', html:`<div class="wr-in">
        <p class="wr-kicker">Su salud</p>
        <h3 class="wr-title">🩺 El año en el veterinario</h3>
        <div class="wr-mini">
          ${d.vaccines?`<div><b>${d.vaccines}</b><span>vacuna${d.vaccines===1?'':'s'} registrada${d.vaccines===1?'':'s'}</span></div>`:''}
          ${d.carnet?`<div><b>${d.carnet}</b><span>documento${d.carnet===1?'':'s'} en el carnet</span></div>`:''}
          ${d.pain?`<div><b>${d.pain}</b><span>aviso${d.pain===1?'':'s'} de molestia</span></div>`:''}
        </div>
        <p class="wr-sub">${d.pain
          ? `${n} avisó ${d.pain} ${d.pain===1?'vez':'veces'} que algo no andaba bien. Esos son los sonidos que nunca hay que dejar pasar.`
          : `Sin avisos de dolor ni malestar en el período. La mejor estadística del año.`}</p>
      </div>`});
    }

    S.push({bg:'g10', html:`<div class="wr-in wr-center">
      <p class="wr-kicker">Su personalidad del año</p>
      <div class="wr-emo">${d.persona.emo}</div>
      <h3 class="wr-hero2">${d.persona.name}</h3>
      <p class="wr-sub">${d.persona.txt}</p>
    </div>`});

    S.push({bg:'g1', last:true, html:`<div class="wr-in wr-center">
      <div class="wr-avatar sm">${avatar}</div>
      <h3 class="wr-hero2">El ${d.year} de ${n}</h3>
      <div class="wr-summary">
        <div><b>${nf(d.total)}</b><span>sonidos</span></div>
        <div><b>${String(d.peakHour).padStart(2,'0')}h</b><span>hora punta</span></div>
        ${d.topEmo?`<div><b>${this.EMOS[d.topEmo].emoji}</b><span>${this.EMOS[d.topEmo].label}</span></div>`:''}
        <div><b>${d.persona.emo}</b><span>${d.persona.name}</span></div>
      </div>
      <button class="wr-share" onclick="App.shareWrapped(event)">📤 Compartir su año</button>
      <button class="wr-again" onclick="App.wrGo(0)">↺ Verlo de nuevo</button>
    </div>`});

    return S;
  },

  /* --- reproductor tipo historia --- */
  openWrapped(){
    if(!this.state.pet){ this.toast('Primero crea el perfil de tu mascota 🐶'); return; }
    const d=this.wrappedData();
    this._wrData=d;
    const stage=document.getElementById('wrStage'), bars=document.getElementById('wrBars');
    this.go('wrapped');
    if(!d || d.total<5){
      bars.innerHTML=''; bars.hidden=true;
      const falta=5-(d?d.total:0);
      stage.innerHTML=`<div class="wr-slide g1 on"><div class="wr-in wr-center">
        <div class="wr-emo">🎁</div>
        <h3 class="wr-hero2">Su Wrapped<br>se está cocinando</h3>
        <p class="wr-sub">Necesitamos al menos 5 sonidos registrados para contar la historia del año. ${d&&d.total?`Llevas <b>${d.total}</b>.`:''} Faltan <b>${falta}</b>.</p>
        <div class="wr-prog"><i style="--w:${Math.round(((d?d.total:0)/5)*100)}%"></i></div>
        <button class="wr-share" onclick="App.closeWrapped();App.go('listen')">🎙️ Escuchar ahora</button>
      </div></div>`;
      return;
    }
    bars.hidden=false;
    this.wr.slides=this.wrappedSlides(d);
    stage.innerHTML=this.wr.slides.map((s,i)=>`<div class="wr-slide ${s.bg}" data-i="${i}">${s.html}</div>`).join('');
    bars.innerHTML=this.wr.slides.map(()=>`<div class="wr-bar"><i></i></div>`).join('');
    this.wrBind();
    this.wrGo(0);
  },

  closeWrapped(){ clearTimeout(this.wr.timer); this.wr.timer=null; this.go('home'); },

  wrGo(i){
    const S=this.wr.slides; if(!S.length) return;
    if(i<0) i=0;
    if(i>=S.length){ i=S.length-1; }
    this.wr.i=i; this.wr.paused=false;
    document.querySelectorAll('#wrStage .wr-slide').forEach((el,k)=>el.classList.toggle('on',k===i));
    document.querySelectorAll('#wrBars .wr-bar').forEach((b,k)=>{
      const bar=b.firstElementChild;
      bar.style.animation='none'; void bar.offsetWidth;
      if(k<i) bar.style.width='100%';
      else if(k>i) bar.style.width='0%';
      else { bar.style.width=''; bar.style.animation=`wrFill ${this.WR_DUR}ms linear forwards`; }
    });
    clearTimeout(this.wr.timer);
    if(S[i].last){ this.confetti(); return; }   // la última no avanza sola
    this._wrT0=Date.now(); this._wrLeft=this.WR_DUR;
    this.wr.timer=setTimeout(()=>this.wrGo(this.wr.i+1), this.WR_DUR);
  },
  WR_DUR:6000,

  wrPause(){
    if(this.wr.paused||!this.wr.timer) return;
    this.wr.paused=true; clearTimeout(this.wr.timer); this.wr.timer=null;
    this._wrLeft=Math.max(400, this._wrLeft-(Date.now()-this._wrT0));
    const b=document.querySelectorAll('#wrBars .wr-bar')[this.wr.i];
    if(b) b.firstElementChild.style.animationPlayState='paused';
  },
  wrResume(){
    if(!this.wr.paused) return;
    this.wr.paused=false;
    const b=document.querySelectorAll('#wrBars .wr-bar')[this.wr.i];
    if(b) b.firstElementChild.style.animationPlayState='running';
    this._wrT0=Date.now();
    this.wr.timer=setTimeout(()=>this.wrGo(this.wr.i+1), this._wrLeft);
  },

  wrBind(){
    if(this._wrBound) return; this._wrBound=true;
    const stage=document.getElementById('wrStage');
    let t0=0, held=false, x0=0, hold=null;
    const down=e=>{
      if(e.target.closest('button')) return;
      t0=Date.now(); held=false; x0=e.touches?e.touches[0].clientX:e.clientX;
      hold=setTimeout(()=>{ held=true; this.wrPause(); }, 240);
    };
    const up=e=>{
      if(e.target.closest('button')) return;
      clearTimeout(hold);
      if(held){ this.wrResume(); return; }
      const x=e.changedTouches?e.changedTouches[0].clientX:e.clientX;
      const w=stage.getBoundingClientRect();
      if(Math.abs(x-x0)>60){ this.wrGo(this.wr.i+(x<x0?1:-1)); return; }
      this.wrGo(this.wr.i + ((x-w.left)/w.width<0.3 ? -1 : 1));
    };
    stage.addEventListener('pointerdown',down);
    stage.addEventListener('pointerup',up);
    stage.addEventListener('pointercancel',()=>{clearTimeout(hold); this.wrResume();});
    document.addEventListener('keydown',e=>{
      if(!document.getElementById('screen-wrapped').classList.contains('active')) return;
      if(e.key==='ArrowRight') this.wrGo(this.wr.i+1);
      if(e.key==='ArrowLeft') this.wrGo(this.wr.i-1);
      if(e.key==='Escape') this.closeWrapped();
    });
  },

  /* --- tarjeta compartible (canvas 1080×1920) --- */
  async shareWrapped(ev){
    if(ev) ev.stopPropagation();
    const d=this._wrData; if(!d) return;
    this.wrPause();
    this.toast('Preparando su tarjeta… 🎨');
    try{ await document.fonts.ready; }catch(e){}
    const canvas=await this.wrappedCard(d);
    canvas.toBlob(async blob=>{
      const file=new File([blob], `wrapped-${d.name.toLowerCase().replace(/\s+/g,'-')}-${d.year}.png`, {type:'image/png'});
      const txt=`El ${d.year} de ${d.name}: ${d.total} sonidos interpretados. Es ${d.persona.name} ${d.persona.emo} · hecho con DogTalk AI`;
      if(navigator.canShare && navigator.canShare({files:[file]})){
        try{ await navigator.share({files:[file], text:txt}); this.toast('¡Compartido! 🐾'); }
        catch(err){ if(err.name!=='AbortError') this.wrDownload(canvas, file.name); }
      } else this.wrDownload(canvas, file.name);
    },'image/png');
  },
  wrDownload(canvas, name){
    const a=document.createElement('a');
    a.download=name; a.href=canvas.toDataURL('image/png'); a.click();
    this.toast('Tarjeta descargada 📥 Súbela a tus historias');
  },

  wrappedCard(d){
    const W=1080,H=1920, c=document.createElement('canvas');
    c.width=W; c.height=H;
    const x=c.getContext('2d');
    const g=x.createLinearGradient(0,0,W*.4,H);
    g.addColorStop(0,'#FF6B4A'); g.addColorStop(.45,'#9B5DE5'); g.addColorStop(1,'#2EC4B6');
    x.fillStyle=g; x.fillRect(0,0,W,H);
    // huellitas decorativas
    x.globalAlpha=.09; x.fillStyle='#fff';
    const paw=(px,py,s)=>{
      x.beginPath(); x.ellipse(px,py,7*s,9*s,0,0,7); x.fill();
      [[-12,-12],[-2,-17],[8,-15],[14,-6]].forEach(([ox,oy])=>{
        x.beginPath(); x.ellipse(px+ox*s,py+oy*s,3.5*s,4.5*s,0,0,7); x.fill();
      });
    };
    for(let i=0;i<26;i++) paw(Math.random()*W, Math.random()*H, 1.6+Math.random()*2.2);
    x.globalAlpha=1;

    const center=(t,y,font,col='#fff')=>{ x.font=font; x.fillStyle=col; x.textAlign='center'; x.fillText(t,W/2,y); };
    const F=(w,s)=>`${w} ${s}px 'Baloo 2', 'Nunito', system-ui, sans-serif`;
    const Fb=(w,s)=>`${w} ${s}px 'Nunito', system-ui, sans-serif`;

    // ajusta el cuerpo para que un nombre largo no se salga de la tarjeta
    const fit=(t,size,maxW,mk)=>{ let s=size; x.font=mk(800,s);
      while(x.measureText(t).width>maxW && s>28){ s-=4; x.font=mk(800,s); } return mk(800,s); };
    center('DOGTALK AI · WRAPPED', 130, Fb(800,34), 'rgba(255,255,255,.75)');
    center(`El ${d.year} de`, 250, F(700,64));
    center(d.name, 350, fit(d.name,96,W-160,F));

    // dato principal
    x.globalAlpha=.14; x.fillStyle='#fff';
    this.wrRoundRect(x, 90, 430, W-180, 250, 44); x.fill(); x.globalAlpha=1;
    center(d.total.toLocaleString('es-CL'), 570, F(800,132));
    center('sonidos interpretados', 640, Fb(700,40), 'rgba(255,255,255,.85)');

    // fila de datos
    const cells=[
      [String(d.peakHour).padStart(2,'0')+'h','su hora punta'],
      [d.topMeaning?MEANINGS[d.topMeaning].emoji:'🐾', d.topMeaning?MEANINGS[d.topMeaning].label.toLowerCase():'—'],
      [d.topEmo?this.EMOS[d.topEmo].emoji:'😊', d.topEmo?this.EMOS[d.topEmo].label.toLowerCase():'—'],
    ];
    cells.forEach((cell,i)=>{
      const cx=W/2+(i-1)*310;
      x.globalAlpha=.14; x.fillStyle='#fff';
      this.wrRoundRect(x, cx-140, 740, 280, 240, 40); x.fill(); x.globalAlpha=1;
      x.textAlign='center'; x.fillStyle='#fff'; x.font=F(800,78); x.fillText(cell[0], cx, 850);
      x.font=Fb(700,28); x.fillStyle='rgba(255,255,255,.85)';
      x.fillText(cell[1].length>14?cell[1].slice(0,13)+'…':cell[1], cx, 920);
    });

    // personalidad
    x.globalAlpha=.16; x.fillStyle='#fff';
    this.wrRoundRect(x, 90, 1040, W-180, 470, 48); x.fill(); x.globalAlpha=1;
    center('SU PERSONALIDAD DEL AÑO', 1120, Fb(800,30), 'rgba(255,255,255,.8)');
    center(d.persona.emo, 1265, F(400,120));
    center(d.persona.name, 1360, fit(d.persona.name,64,W-220,F));
    this.wrWrap(x, d.persona.txt, W/2, 1425, W-260, 44, Fb(600,32), 'rgba(255,255,255,.9)');

    // pie
    center(`${d.daysTracked} días escuchándolo · ${d.streak} seguidos`, 1640, Fb(700,36));
    center('🐾', 1740, F(400,64));
    center('Hecho con DogTalk AI', 1820, Fb(800,34), 'rgba(255,255,255,.8)');
    return Promise.resolve(c);
  },
  wrRoundRect(x,px,py,w,h,r){
    x.beginPath();
    x.moveTo(px+r,py); x.arcTo(px+w,py,px+w,py+h,r); x.arcTo(px+w,py+h,px,py+h,r);
    x.arcTo(px,py+h,px,py,r); x.arcTo(px,py,px+w,py,r); x.closePath();
  },
  wrWrap(x,text,cx,cy,maxW,lh,font,col){
    x.font=font; x.fillStyle=col; x.textAlign='center';
    const words=text.split(' '); let line='', y=cy;
    words.forEach(w=>{
      const t=line?line+' '+w:w;
      if(x.measureText(t).width>maxW){ x.fillText(line,cx,y); y+=lh; line=w; }
      else line=t;
    });
    if(line) x.fillText(line,cx,y);
  },

  /* ---------- util ---------- */
  confetti(){
    const c=document.createElement('div'); c.className='confetti';
    const cols=['#FF6B4A','#2EC4B6','#FFBF3F','#9B5DE5','#FF8FA3'];
    for(let i=0;i<34;i++){
      const p=document.createElement('i');
      p.style.left=Math.random()*100+'%';
      p.style.top=-14+Math.random()*10+'px';
      p.style.background=cols[i%cols.length];
      p.style.setProperty('--t',(1.5+Math.random()*1.1)+'s');
      p.style.animationDelay=(Math.random()*.35)+'s';
      if(i%3===0) p.style.borderRadius='50%';
      c.appendChild(p);
    }
    document.body.appendChild(c);
    setTimeout(()=>c.remove(),3200);
  },
  EMPTY_ILLU:`<div class="empty-illu"><svg viewBox="0 0 120 120">
    <ellipse cx="60" cy="104" rx="30" ry="5" fill="currentColor" opacity=".18"/>
    <ellipse cx="60" cy="66" rx="34" ry="31" fill="currentColor" opacity=".22"/>
    <path d="M30 40 C18 32 14 56 21 70 C27 82 39 79 41 67 Z" fill="currentColor" opacity=".3"/>
    <path d="M90 40 C102 32 106 56 99 70 C93 82 81 79 79 67 Z" fill="currentColor" opacity=".3"/>
    <ellipse cx="60" cy="79" rx="22" ry="17" fill="currentColor" opacity=".14"/>
    <circle cx="48" cy="60" r="4.6" fill="currentColor" opacity=".6"/>
    <circle cx="72" cy="60" r="4.6" fill="currentColor" opacity=".6"/>
    <path d="M53 74 Q60 69 67 74 Q60 81 53 74Z" fill="currentColor" opacity=".6"/>
  </svg><p>__TXT__</p></div>`,
  emptyIllu(txt){ return this.EMPTY_ILLU.replace('__TXT__',txt); },
  toast(msg){
    const t=document.getElementById('toast'); t.textContent=msg; t.hidden=false;
    clearTimeout(this._tt); this._tt=setTimeout(()=>t.hidden=true, 3200);
  },
  notify(title, body, opts){
    if(!this.state.settings.notif || !window.Notification || Notification.permission!=='granted') return;
    const o={body, icon:'icon-192.png', badge:'icon-192.png', ...(opts||{})};
    // en Android la notificación debe salir por el service worker
    if(navigator.serviceWorker && navigator.serviceWorker.ready){
      navigator.serviceWorker.ready.then(reg=>reg.showNotification(title,o))
        .catch(()=>{ try{ new Notification(title,o); }catch(e){} });
    } else { try{ new Notification(title,o); }catch(e){} }
  },
  exportData(){
    const blob=new Blob([JSON.stringify(this.state,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='dogtalk_datos.json'; a.click();
  },
  resetAll(){
    if(confirm('¿Borrar TODOS los datos de DogTalk AI?')){ localStorage.removeItem('dogtalk'); location.reload(); }
  },

  /* ══════════════════════════════════════════════════════════════════════
     EDAD PRECISA Y ETAPA VITAL
     La edad decimal (p.age) sigue existiendo para el resto del código, pero
     ahora se deriva de la fecha de nacimiento y se recalcula en cada arranque.
     ══════════════════════════════════════════════════════════════════════ */
  ageMonths(p){
    p = p===undefined ? this.state.pet : p;
    if(!p) return null;
    if(p.birth){
      const b=new Date(p.birth+'T12:00:00'), n=new Date();
      if(isNaN(b)) return null;
      let m=(n.getFullYear()-b.getFullYear())*12+(n.getMonth()-b.getMonth());
      if(n.getDate()<b.getDate()) m--;
      return Math.max(0,m);
    }
    if(p.ageY!==undefined&&p.ageY!==null&&p.ageY!=='') return (+p.ageY||0)*12+(+p.ageM||0);
    if(p.age) return Math.round(parseFloat(p.age)*12);
    return null;
  },
  ageYears(p){ const m=this.ageMonths(p); return m==null?null:+(m/12).toFixed(2); },
  ageLabel(p){
    const m=this.ageMonths(p);
    if(m==null) return 'edad no registrada';
    const y=Math.floor(m/12), r=m%12;
    if(m===0) return 'menos de 1 mes';
    if(!y) return `${r} ${r===1?'mes':'meses'}`;
    if(!r) return `${y} ${y===1?'año':'años'}`;
    return `${y} ${y===1?'año':'años'} y ${r} ${r===1?'mes':'meses'}`;
  },
  // las razas grandes envejecen antes: el umbral senior se corre según el peso
  lifeStage(p){
    p = p===undefined ? this.state.pet : p;
    const m=this.ageMonths(p), w=parseFloat(p&&p.weight)||0;
    if(m==null) return {key:'adulto',label:'Adulto',emoji:'🐕',note:''};
    const seniorAt = w>=40?84 : w>=25?90 : 108; // meses
    if(m<4)  return {key:'lactante',label:'Cachorro (0–4 meses)',emoji:'🍼',note:'Etapa de socialización y vacunación primaria.'};
    if(m<12) return {key:'cachorro',label:'Cachorro (4–12 meses)',emoji:'🐶',note:'Crecimiento rápido: alimento de cachorro y ejercicio moderado.'};
    if(m<24) return {key:'joven',label:'Adulto joven',emoji:'🐕',note:'Madurez conductual en curso; mucha energía.'};
    if(m<seniorAt) return {key:'adulto',label:'Adulto',emoji:'🐕',note:'Control veterinario anual.'};
    if(m<seniorAt+36) return {key:'senior',label:'Senior',emoji:'🐕‍🦺',note:'Chequeos cada 6 meses y control de peso.'};
    return {key:'geriatrico',label:'Geriátrico',emoji:'🐕‍🦺',note:'Chequeos cada 6 meses con exámenes de sangre y presión.'};
  },
  syncAges(){
    (this.state.pets||[]).forEach(p=>{ const y=this.ageYears(p); if(y!=null) p.age=y; });
  },
  isBirthday(p){
    p = p===undefined ? this.state.pet : p;
    if(!p||!p.birth) return false;
    const b=new Date(p.birth+'T12:00:00'), n=new Date();
    return b.getDate()===n.getDate() && b.getMonth()===n.getMonth() && n.getFullYear()>b.getFullYear();
  },
  onBirthChange(){
    const b=document.getElementById('petBirth').value;
    const hint=document.getElementById('ageHint');
    if(!b){ hint.textContent='Si no la sabes exacta, deja el campo vacío y usa la edad aproximada.'; return; }
    const m=this.ageMonths({birth:b});
    if(m==null||m<0){ hint.textContent='Revisa la fecha: no puede ser futura.'; return; }
    document.getElementById('petAgeY').value=Math.floor(m/12);
    document.getElementById('petAgeM').value=m%12;
    const st=this.lifeStage({birth:b,weight:document.getElementById('petWeight').value});
    hint.innerHTML=`🎂 <b>${this.ageLabel({birth:b})}</b> · ${st.emoji} ${st.label}`;
  },
  onManualAge(){
    if(document.getElementById('petBirth').value) return;
    const y=+document.getElementById('petAgeY').value||0, mo=+document.getElementById('petAgeM').value||0;
    const st=this.lifeStage({ageY:y,ageM:mo,weight:document.getElementById('petWeight').value});
    document.getElementById('ageHint').innerHTML = (y||mo)
      ? `📅 <b>${this.ageLabel({ageY:y,ageM:mo})}</b> · ${st.emoji} ${st.label} <span style="opacity:.7">(más exacto con la fecha de nacimiento)</span>`
      : 'Si no la sabes exacta, deja el campo vacío y usa la edad aproximada.';
  },

  /* ---------- utilidades de fecha ---------- */
  dateKey(d){ d = d===undefined?new Date():new Date(d);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); },
  minOf(hhmm){ const [h,m]=String(hhmm).split(':').map(Number); return (h||0)*60+(m||0); },
  addDays(key,n){ const d=new Date(key+'T12:00:00'); d.setDate(d.getDate()+n); return this.dateKey(d); },
  prettyDay(key){
    const today=this.dateKey(), yest=this.addDays(today,-1), tom=this.addDays(today,1);
    if(key===today) return 'Hoy'; if(key===yest) return 'Ayer'; if(key===tom) return 'Mañana';
    return new Date(key+'T12:00:00').toLocaleDateString('es-CL',{weekday:'short',day:'2-digit',month:'short'});
  },

  /* ══════════════════════════════════════════════════════════════════════
     RUTINA DE COMIDAS
     ══════════════════════════════════════════════════════════════════════ */
  mealsOf(){
    const p=this.state.pet; if(!p) return {times:[],grams:null,log:{}};
    if(!p.meals) p.meals={times:[],grams:null,log:{}};
    if(!p.meals.log) p.meals.log={};
    if(!Array.isArray(p.meals.times)) p.meals.times=[];
    return p.meals;
  },
  suggestMealTimes(n){
    return ({1:['09:00'],2:['08:00','19:00'],3:['08:00','14:00','20:00'],4:['07:00','12:00','17:00','21:00']})[n]||['08:00','19:00'];
  },
  addMealTime(){
    const t=document.getElementById('newMealTime').value; if(!t) return;
    const m=this.mealsOf();
    if(m.times.includes(t)){ this.toast('Ese horario ya está 🍽️'); return; }
    m.times.push(t); m.times.sort((a,b)=>this.minOf(a)-this.minOf(b));
    this.save(); this.renderMeals(); this.toast(`Comida de las ${t} agregada 🍲`);
    this.askNotifPermission();
  },
  delMealTime(t){
    const m=this.mealsOf(); m.times=m.times.filter(x=>x!==t); this.save(); this.renderMeals();
  },
  useSuggestedMeals(){
    const r=this.rationCalc(this.state.pet);
    const m=this.mealsOf(); m.times=this.suggestMealTimes(r?r.tomas:2);
    if(r) m.grams=r.perMeal;
    this.save(); this.renderMeals(); this.confetti();
    this.toast(`Rutina creada: ${m.times.length} comidas al día ✅`);
    this.askNotifPermission();
  },
  toggleMealDone(t){
    const m=this.mealsOf(), k=this.dateKey();
    m.log[k]=m.log[k]||{};
    if(m.log[k][t]){ delete m.log[k][t]; }
    else { m.log[k][t]=Date.now(); this.confetti(); }
    this.save(); this.renderMeals(); this.renderAgenda();
  },
  saveMealGrams(){
    const v=parseFloat(document.getElementById('mealGrams').value);
    const m=this.mealsOf(); m.grams = isNaN(v)||v<=0 ? null : v;
    this.save(); this.renderMeals(); this.toast(m.grams?`${m.grams} g por toma guardados 🥣`:'Gramos borrados');
  },
  renderMeals(){
    const p=this.state.pet, m=this.mealsOf(), k=this.dateKey();
    const done=m.log[k]||{};
    const r=this.rationCalc(p);
    const doneCount=m.times.filter(t=>done[t]).length;
    document.getElementById('mealHero').innerHTML = m.times.length ? `
      <div class="mh-ring"><b>${doneCount}</b><small>de ${m.times.length}</small></div>
      <div class="mh-txt">
        <p class="mh-title">${p?p.name:'Tu perro'} come <b>${m.times.length} ${m.times.length===1?'vez':'veces'}</b> al día</p>
        <p class="mh-sub">${m.grams?`${m.grams} g por toma · ${m.grams*m.times.length} g diarios`:'Sin gramaje registrado'}${doneCount===m.times.length?' · ¡todo servido hoy! 🎉':''}</p>
      </div>` : `
      <div class="mh-empty">
        <p>🍽️ Aún no defines la rutina de comidas.</p>
        ${r?`<button class="btn-primary btn-inline" onclick="App.useSuggestedMeals()">Usar ${r.tomas} tomas de ${r.perMeal} g</button>`
           :`<p class="mh-sub">Agrega el peso de tu perro en el perfil y te calculo la ración.</p>`}
      </div>`;

    document.getElementById('mealTimes').innerHTML = m.times.length ? m.times.map(t=>{
      const ok=!!done[t];
      const late = !ok && this.minOf(t) < (new Date().getHours()*60+new Date().getMinutes());
      return `<div class="meal-row ${ok?'done':late?'late':''}">
        <button class="meal-check" onclick="App.toggleMealDone('${t}')">${ok?'✅':'⭕'}</button>
        <div class="meal-info"><p class="meal-time">${t}</p>
          <p class="meal-meta">${ok?`Servida a las ${new Date(done[t]).toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'})}`:late?'Pendiente (ya pasó la hora)':'Programada'}${m.grams?` · ${m.grams} g`:''}</p></div>
        <button class="vi-del" onclick="App.delMealTime('${t}')">🗑️</button>
      </div>`;
    }).join('') : this.emptyIllu('Sin horarios de comida.<br>Agrega el primero abajo.');

    document.getElementById('mealRation').innerHTML = r ? `
      <div class="ration-box">
        <p>🔥 <b>${r.mer} kcal</b> al día (RER ${r.rer} × factor ${r.factor})</p>
        <p>🥣 <b>${r.grams} g</b> de alimento seco al día — <b>${r.tomas} tomas</b> de ~${r.perMeal} g</p>
        <p class="ration-note">Calculado para ${p.name}: ${r.etapa}. Ajusta según las kcal reales de tu marca y su condición corporal.</p>
      </div>` : `<div class="ration-box empty">Agrega el <b>peso</b> de tu perro en el perfil para calcular la ración exacta.</div>`;
    document.getElementById('mealGrams').value = m.grams||'';

    // últimos 7 días
    const days=[]; for(let i=6;i>=0;i--) days.push(this.addDays(k,-i));
    document.getElementById('mealWeek').innerHTML = m.times.length ? days.map(d=>{
      const lg=m.log[d]||{};
      const n=m.times.filter(t=>lg[t]).length;
      const pct = m.times.length? n/m.times.length : 0;
      return `<div class="mw-day">
        <div class="mw-bar"><span style="height:${Math.round(pct*100)}%"></span></div>
        <p class="mw-n">${n}/${m.times.length}</p>
        <p class="mw-lbl">${new Date(d+'T12:00:00').toLocaleDateString('es-CL',{weekday:'short'}).slice(0,3)}</p>
      </div>`;
    }).join('') : '<p class="sec-sub">Define horarios para ver el seguimiento semanal.</p>';
    this.renderBag();
  },

  /* ══════════════════════════════════════════════════════════════════════
     CONTROL DE PESO
     ══════════════════════════════════════════════════════════════════════ */
  saveWeight(){
    const kg=parseFloat(document.getElementById('wKg').value);
    const date=document.getElementById('wDate').value||this.dateKey();
    if(!kg||kg<=0){ this.toast('Indica un peso válido ⚖️'); return; }
    if(kg>120){ this.toast('¿Seguro? Ese peso parece muy alto 🤔'); }
    const list=this.state.weights;
    const prev=list.slice().sort((a,b)=>a.date.localeCompare(b.date)).pop();
    const same=list.find(w=>w.date===date);
    if(same) same.kg=kg; else list.push({id:'w'+Date.now(), date, kg});
    // el peso del perfil siempre refleja el registro más reciente
    const latest=list.slice().sort((a,b)=>a.date.localeCompare(b.date)).pop();
    if(this.state.pet) this.state.pet.weight=latest.kg;
    this.save();
    document.getElementById('wKg').value='';
    this.renderWeight();
    if(prev){
      const d=+(kg-prev.kg).toFixed(1), pct=Math.abs(d/prev.kg*100);
      this.toast(d===0?'Peso estable ⚖️':`${d>0?'Subió':'Bajó'} ${Math.abs(d)} kg (${pct.toFixed(1)}%) desde ${new Date(prev.date+'T12:00:00').toLocaleDateString('es-CL')}`);
    } else this.toast('Primer peso registrado ⚖️ Pésalo cada 2–4 semanas.');
  },
  delWeight(id){
    if(!confirm('¿Eliminar este registro de peso?')) return;
    this.state.weights=this.state.weights.filter(w=>w.id!==id);
    const latest=this.state.weights.slice().sort((a,b)=>a.date.localeCompare(b.date)).pop();
    if(latest&&this.state.pet) this.state.pet.weight=latest.kg;
    this.save(); this.renderWeight();
  },
  weightTrend(days){
    const list=(this.state.weights||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
    if(list.length<2) return null;
    const since=this.addDays(this.dateKey(),-days);
    const win=list.filter(w=>w.date>=since);
    if(win.length<2) return null;
    const a=win[0], b=win[win.length-1];
    const diff=+(b.kg-a.kg).toFixed(2);
    return {from:a, to:b, diff, pct:+(diff/a.kg*100).toFixed(1), days};
  },
  weightChart(list){
    if(list.length<2) return '<p class="sec-sub">Registra al menos dos pesos para ver la curva 📈</p>';
    const pts=list.slice(-14);
    const kgs=pts.map(p=>p.kg);
    const min=Math.min(...kgs), max=Math.max(...kgs);
    const pad=(max-min)*0.25 || 0.5;
    const lo=min-pad, hi=max+pad, W=320, H=130, m=18;
    const x=i=>m+(i*(W-m*2))/(pts.length-1);
    const y=v=>H-m-((v-lo)/(hi-lo))*(H-m*2);
    const line=pts.map((p,i)=>`${x(i).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ');
    const area=`${m},${H-m} ${line} ${W-m},${H-m}`;
    return `<svg viewBox="0 0 ${W} ${H}" class="wsvg" preserveAspectRatio="none">
      <polygon points="${area}" fill="url(#wg)"/>
      <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--teal)" stop-opacity=".35"/><stop offset="100%" stop-color="var(--teal)" stop-opacity="0"/>
      </linearGradient></defs>
      <polyline points="${line}" fill="none" stroke="var(--teal)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map((p,i)=>`<circle cx="${x(i).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="4" fill="var(--card)" stroke="var(--teal)" stroke-width="2.5"/>`).join('')}
      <text x="${m}" y="12" class="wsvg-t">${max} kg</text>
      <text x="${m}" y="${H-4}" class="wsvg-t">${min} kg</text>
    </svg>`;
  },
  renderWeight(){
    const p=this.state.pet;
    const list=(this.state.weights||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
    const last=list[list.length-1];
    const t30=this.weightTrend(30), t90=this.weightTrend(90);
    document.getElementById('wDate').value=this.dateKey();
    document.getElementById('wHero').innerHTML = last ? `
      <div class="wh-main"><b>${last.kg}</b><span>kg</span></div>
      <div class="wh-side">
        <p class="wh-lbl">Último registro</p>
        <p class="wh-date">${new Date(last.date+'T12:00:00').toLocaleDateString('es-CL',{day:'2-digit',month:'long'})}</p>
        ${t30?`<p class="wh-trend ${t30.diff>0?'up':t30.diff<0?'down':''}">${t30.diff>0?'▲':t30.diff<0?'▼':'●'} ${Math.abs(t30.diff)} kg (${Math.abs(t30.pct)}%) en 30 días</p>`:''}
      </div>` : `<div class="mh-empty"><p>⚖️ Sin registros de peso todavía.</p><p class="mh-sub">Pesar cada 2–4 semanas es la forma más simple de detectar problemas a tiempo.</p></div>`;
    document.getElementById('wChart').innerHTML=this.weightChart(list);

    // lectura clínica de la variación
    let note='';
    const ref=t30||t90;
    if(ref){
      const ap=Math.abs(ref.pct);
      if(ap>=10) note=`<div class="w-alert danger">⚠️ El peso ${ref.diff>0?'subió':'bajó'} un <b>${ap}%</b> en ${ref.days} días. Una variación mayor al 10% sin cambio de dieta merece consulta veterinaria${ref.diff<0?' (pérdida de peso involuntaria)':''}.</div>`;
      else if(ap>=5) note=`<div class="w-alert warn">👀 Variación del <b>${ap}%</b> en ${ref.days} días. Revisa la ración y el ejercicio; si sigue la tendencia, consúltalo.</div>`;
      else note=`<div class="w-alert ok">✅ Peso estable (${ref.diff>0?'+':''}${ref.diff} kg en ${ref.days} días). Así se ve un buen control.</div>`;
    }
    const r=this.rationCalc(p);
    if(r) note+=`<div class="w-alert info">🥣 Con ${r.w} kg, ${p.name} necesita ~<b>${r.mer} kcal</b> (${r.grams} g) al día. <span onclick="App.go('meals')" style="text-decoration:underline;cursor:pointer">Ver rutina de comidas</span></div>`;
    document.getElementById('wNote').innerHTML=note;

    document.getElementById('wList').innerHTML = list.length ? list.slice().reverse().map((w,i,arr)=>{
      const prev=arr[i+1];
      const d=prev?+(w.kg-prev.kg).toFixed(2):null;
      return `<div class="w-item">
        <span class="wi-kg">${w.kg} kg</span>
        <span class="wi-date">${new Date(w.date+'T12:00:00').toLocaleDateString('es-CL',{day:'2-digit',month:'short',year:'2-digit'})}</span>
        ${d!==null?`<span class="wi-diff ${d>0?'up':d<0?'down':''}">${d>0?'+':''}${d} kg</span>`:'<span class="wi-diff">—</span>'}
        <button class="vi-del" onclick="App.delWeight('${w.id}')">🗑️</button>
      </div>`;
    }).join('') : this.emptyIllu('Sin registros de peso.');
  },

  /* ══════════════════════════════════════════════════════════════════════
     REGISTRO DE MALESTARES (síntomas)
     Catálogo con banderas rojas (urgencia por sí solas) y reglas de patrón.
     ══════════════════════════════════════════════════════════════════════ */
  SYMPTOMS:{
    vomito:{e:'🤮',l:'Vómito'},
    diarrea:{e:'💩',l:'Diarrea'},
    sangre:{e:'🩸',l:'Sangre en heces/vómito',red:true},
    no_come:{e:'🥣',l:'No quiere comer'},
    no_bebe:{e:'💧',l:'No bebe agua'},
    decaido:{e:'😔',l:'Decaído / apático'},
    cojera:{e:'🦿',l:'Cojera'},
    tos:{e:'😮‍💨',l:'Tos'},
    estornudo:{e:'🤧',l:'Estornudos / mocos'},
    rascado:{e:'🐾',l:'Se rasca mucho'},
    orejas:{e:'👂',l:'Sacude las orejas'},
    ojos:{e:'👁️',l:'Ojos con secreción'},
    temblor:{e:'🥶',l:'Temblores'},
    convulsion:{e:'⚡',l:'Convulsión',red:true},
    respira:{e:'😰',l:'Le cuesta respirar',red:true},
    abdomen:{e:'🎈',l:'Abdomen hinchado y duro',red:true},
    orina:{e:'🚽',l:'Orina rara / le cuesta',},
    herida:{e:'🩹',l:'Herida o golpe'},
    fiebre:{e:'🌡️',l:'Se siente afiebrado'},
    otro_sintoma:{e:'📌',l:'Otro malestar'},
  },
  FP_REASONS:{
    tv:{e:'📺',l:'TV / radio'},
    otro_perro:{e:'🐕',l:'Otro perro'},
    calle:{e:'🚗',l:'Ruido de la calle'},
    timbre:{e:'🔔',l:'Timbre / alarma'},
    persona:{e:'🗣️',l:'Voz humana'},
    musica:{e:'🎵',l:'Música'},
    juguete:{e:'🧸',l:'Juguete / roce'},
    otro_fp:{e:'❓',l:'Otro ruido'},
  },
  _symType:null,
  openSymSheet(type){
    this._symType=type;
    const s=this.SYMPTOMS[type];
    document.getElementById('symSheetTitle').textContent=`${s.e} ${s.l}`;
    document.getElementById('symSheetSub').textContent=s.red
      ? '⚠️ Este signo puede ser una urgencia veterinaria por sí solo.'
      : 'Registra la hora real: los patrones son lo que más ayuda al veterinario.';
    document.getElementById('symNote').value='';
    this._symPhoto=null;
    document.getElementById('symPhoto').innerHTML='<span>📷</span><p>Agregar foto — una imagen de la herida, la cojera o la deposición vale más que la descripción en la consulta</p>';
    document.getElementById('symWhenCustom').hidden=true;
    document.querySelectorAll('#symWhen .chip').forEach((c,i)=>c.classList.toggle('sel',i===0));
    document.querySelectorAll('#symSeverity .chip').forEach((c,i)=>c.classList.toggle('sel',i===0));
    document.getElementById('symBackdrop').hidden=false;
    document.getElementById('symSheet').hidden=false;
  },
  closeSymSheet(){ document.getElementById('symBackdrop').hidden=true; document.getElementById('symSheet').hidden=true; },
  saveSymptom(){
    const when=(document.querySelector('#symWhen .chip.sel')||{}).dataset?.v||'0';
    const sev=(document.querySelector('#symSeverity .chip.sel')||{}).dataset?.v||'leve';
    let ts=Date.now();
    if(when==='custom'){
      const v=document.getElementById('symWhenCustom').value;
      if(!v){ this.toast('Elige la fecha y hora 📅'); return; }
      ts=new Date(v).getTime();
    } else ts=Date.now()-(+when)*60000;
    const rec={id:'s'+Date.now(), ts, type:this._symType, sev,
      note:document.getElementById('symNote').value.trim(), photo:this._symPhoto||null};
    this.state.symptoms.push(rec);
    try{ this.save(); }
    catch(e){ rec.photo=null; this.state.symptoms.pop(); this.state.symptoms.push(rec); this.save();
      this.toast('Sin espacio local: se guardó sin la foto 📦'); }
    this._symPhoto=null;
    this.closeSymSheet(); this.renderSymptoms();
    const v=this.symptomVerdict();
    this.toast(`${this.SYMPTOMS[this._symType].l} registrado`);
    if(v.level==='urgent') this.notify('⚠️ DogTalk AI', v.title);
  },
  // comprime la foto antes de guardarla: localStorage no aguanta un JPEG de cámara
  addSymPhoto(file){
    const r=new FileReader();
    r.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const max=900, sc=Math.min(1,max/Math.max(img.width,img.height));
        const c=document.createElement('canvas');
        c.width=img.width*sc; c.height=img.height*sc;
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        this._symPhoto=c.toDataURL('image/jpeg',0.68);
        document.getElementById('symPhoto').innerHTML=
          `<img src="${this._symPhoto}"><p>Toca para cambiarla</p>`;
      };
      img.src=r.result;
    };
    r.readAsDataURL(file);
  },
  viewPhoto(id){
    const s=(this.state.symptoms||[]).find(x=>x.id===id); if(!s||!s.photo) return;
    const d=document.createElement('div'); d.className='lightbox';
    d.innerHTML=`<button class="lb-close">✕</button><img src="${s.photo}">`;
    d.onclick=()=>d.remove(); document.body.appendChild(d);
  },
  delSymptom(id){
    if(!confirm('¿Eliminar este registro?')) return;
    this.state.symptoms=this.state.symptoms.filter(s=>s.id!==id); this.save(); this.renderSymptoms();
  },
  // Reglas de patrón — orientación, nunca diagnóstico
  symptomVerdict(){
    const S=(this.state.symptoms||[]).slice().sort((a,b)=>b.ts-a.ts);
    const now=Date.now(), ago=h=>now-h*36e5;
    const inH=(t,h)=>S.filter(s=>s.type===t&&s.ts>=ago(h));
    const anyH=h=>S.filter(s=>s.ts>=ago(h));
    const order=['ok','watch','vet','urgent']; let level='ok'; const reasons=[];
    const bump=(l,r)=>{ if(order.indexOf(l)>order.indexOf(level)) level=l; if(r&&!reasons.includes(r)) reasons.push(r); };
    const months=this.ageMonths();
    const fragil = months!=null && (months<6 || months>=96);
    const name=this.state.pet?this.state.pet.name:'Tu perro';

    anyH(24).filter(s=>(this.SYMPTOMS[s.type]||{}).red)
      .forEach(s=>bump('urgent',`${this.SYMPTOMS[s.type].l}: es un signo de urgencia por sí solo, no esperes.`));
    anyH(24).filter(s=>s.sev==='grave')
      .forEach(s=>bump('vet',`${this.SYMPTOMS[s.type].l} marcado como grave en las últimas 24 h.`));

    if(inH('vomito',12).length>=3) bump('urgent','3 o más vómitos en 12 h: riesgo real de deshidratación.');
    else if(inH('vomito',24).length>=2) bump('vet','2 vómitos en 24 h.');
    if(inH('diarrea',24).length>=4) bump('vet','4 o más deposiciones líquidas en 24 h.');
    const dDays=new Set(S.filter(s=>s.type==='diarrea'&&s.ts>=ago(96)).map(s=>this.dateKey(s.ts))).size;
    if(dDays>=3) bump('vet','Diarrea presente 3 días o más seguidos.');
    if(inH('vomito',24).length&&inH('diarrea',24).length)
      bump(fragil?'urgent':'vet',`Vómito y diarrea juntos en 24 h${fragil?` — en ${name}, por su edad, la deshidratación avanza muy rápido.`:'.'}`);
    if(inH('no_come',36).length>=2) bump('vet','Lleva más de un día sin querer comer.');
    if(inH('no_come',24).length&&inH('decaido',24).length) bump('vet','No come y está decaído a la vez.');
    if(inH('no_bebe',24).length>=2) bump('vet','No está bebiendo agua: vigila la deshidratación (pellizca la piel del lomo; debe volver de inmediato).');
    if(inH('cojera',72).length>=3) bump('vet','Cojera repetida en 3 días.');
    if(inH('tos',72).length>=3) bump('vet','Tos persistente por 3 días o más.');
    if(inH('orina',48).length>=2) bump('vet','Problemas urinarios repetidos: en machos, la obstrucción es una urgencia.');
    const distinct=new Set(anyH(48).map(s=>s.type)).size;
    if(distinct>=3) bump('vet',`${distinct} síntomas distintos en 48 h: el cuadro merece revisión profesional.`);
    if(level==='ok'&&anyH(72).length) bump('watch','Hay malestares recientes registrados. Sigue observando y anota cualquier cambio.');

    const meds=(this.state.meds||[]).filter(m=>this.medIsActive(m));
    if(meds.length&&level!=='ok') reasons.push(`Está en tratamiento con ${meds.map(m=>m.name).join(', ')}: menciónalo en la consulta (puede ser un efecto adverso).`);

    const map={
      urgent:{ico:'🚨',title:'Señales de urgencia: contacta a un veterinario ahora',cls:'urgent'},
      vet:{ico:'⚠️',title:'Conviene una consulta veterinaria pronto',cls:'vet'},
      watch:{ico:'👀',title:'En observación',cls:'watch'},
      ok:{ico:'✅',title:`${name} sin malestares registrados`,cls:'ok'},
    };
    return {level, reasons, ...map[level], count:anyH(168).length};
  },
  renderSymptoms(){
    const v=this.symptomVerdict();
    document.getElementById('symVerdict').className='sym-verdict '+v.cls;
    document.getElementById('symVerdict').innerHTML=`
      <div class="sv-head"><span>${v.ico}</span><h4>${v.title}</h4></div>
      ${v.reasons.length?`<ul class="sv-list">${v.reasons.map(r=>`<li>${r}</li>`).join('')}</ul>`:
        '<p class="sv-sub">Registra cualquier vómito, diarrea o decaimiento: con dos o tres datos ya detectamos patrones.</p>'}
      ${this.vetCallHTML(v.level)}
      ${v.level!=='ok'?'<p class="sv-disc">⚕️ Orientación informativa, no un diagnóstico. Ante la duda, consulta siempre.</p>':''}`;

    document.getElementById('symGrid').innerHTML=Object.entries(this.SYMPTOMS).map(([k,s])=>
      `<button class="sym-btn${s.red?' red':''}" onclick="App.openSymSheet('${k}')"><span>${s.e}</span>${s.l}</button>`).join('');

    const S=(this.state.symptoms||[]).slice().sort((a,b)=>b.ts-a.ts);
    const week=Date.now()-7*864e5;
    const recent=S.filter(s=>s.ts>=week);
    const byDay={};
    recent.forEach(s=>{ const k=this.dateKey(s.ts); (byDay[k]=byDay[k]||[]).push(s); });
    document.getElementById('symTimeline').innerHTML=Object.keys(byDay).length
      ? Object.keys(byDay).sort().reverse().map(k=>`
        <div class="st-day"><p class="st-date">${this.prettyDay(k)}</p>
          <div class="st-chips">${byDay[k].map(s=>`<span class="st-chip sev-${s.sev}" title="${s.note||''}">${this.SYMPTOMS[s.type].e} ${this.SYMPTOMS[s.type].l} · ${new Date(s.ts).toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'})}</span>`).join('')}</div>
        </div>`).join('')
      : this.emptyIllu('Sin malestares esta semana. ¡Buena señal! 🎉');

    document.getElementById('symList').innerHTML = S.length ? S.map(s=>{
      const d=this.SYMPTOMS[s.type];
      return `<div class="sym-item">
        <span class="event-emoji">${d.e}</span>
        <div class="event-info"><p class="event-title">${d.l} <span class="sev-tag sev-${s.sev}">${s.sev}</span></p>
          <p class="event-meta">${new Date(s.ts).toLocaleString('es-CL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}${s.note?' · '+s.note.replace(/</g,'&lt;'):''}</p></div>
        ${s.photo?`<img class="sym-thumb" src="${s.photo}" onclick="App.viewPhoto('${s.id}')">`:''}
        <button class="vi-del" onclick="App.delSymptom('${s.id}')">🗑️</button>
      </div>`;
    }).join('') : this.emptyIllu('Sin malestares registrados.');
  },

  /* ══════════════════════════════════════════════════════════════════════
     MEDICAMENTOS · CALENDARIO DE TOMAS · ALARMAS
     ══════════════════════════════════════════════════════════════════════ */
  MED_SUGGEST:['Amoxicilina','Amoxicilina + clavulánico','Metronidazol','Enrofloxacina','Meloxicam','Carprofeno',
    'Prednisolona','Omeprazol','Maropitant (Cerenia)','Apoquel','Antihistamínico','Gotas óticas','Colirio',
    'Antiparasitario interno','Antipulgas','Probiótico','Suplemento articular','Suero oral'],
  medDefaultTimes(f){
    return ({1:['09:00'],2:['09:00','21:00'],3:['07:00','15:00','23:00'],4:['06:00','12:00','18:00','00:00']})[f]||['09:00','21:00'];
  },
  medEndKey(m){ return this.addDays(m.start, (+m.days||1)-1); },
  medRunsOn(m,key){ return !m.stopped && key>=m.start && key<=this.medEndKey(m); },
  medIsActive(m){ return this.medRunsOn(m, this.dateKey()); },
  medStatus(m){
    const k=this.dateKey();
    if(m.stopped) return 'stopped';
    if(k<m.start) return 'upcoming';
    if(k>this.medEndKey(m)) return 'done';
    return 'active';
  },
  medProgress(m){
    const total=(+m.days||1)*(m.times||[]).length;
    const given=Object.values(m.doses||{}).filter(d=>d.st==='taken').length;
    const skipped=Object.values(m.doses||{}).filter(d=>d.st==='skipped').length;
    const dayN=Math.min(+m.days||1, Math.max(1, Math.round((new Date(this.dateKey()+'T12:00:00')-new Date(m.start+'T12:00:00'))/864e5)+1));
    return {total, given, skipped, dayN, days:+m.days||1, pct: total?Math.round(given/total*100):0};
  },
  medDoseState(m,key,time){
    const d=(m.doses||{})[key+'|'+time];
    if(d) return d.st;
    const now=new Date(), today=this.dateKey();
    if(key<today) return 'missed';
    if(key===today && this.minOf(time) < now.getHours()*60+now.getMinutes()) return 'due';
    return 'pending';
  },
  medMark(id,key,time,st){
    const m=(this.state.meds||[]).find(x=>x.id===id); if(!m) return;
    m.doses=m.doses||{};
    const k=key+'|'+time;
    if(m.doses[k]&&m.doses[k].st===st) delete m.doses[k];
    else { m.doses[k]={st, ts:Date.now()}; if(st==='taken') this.confetti(); }
    this.save(); this.renderMeds(); this.renderAgenda();
    const p=this.medProgress(m);
    if(st==='taken'&&p.given===p.total) this.toast(`¡Tratamiento de ${m.name} completado! 🎉`);
  },
  medFreqChanged(){
    const f=+document.getElementById('medFreq').value;
    if(f>0) this._medTimes=this.medDefaultTimes(f);
    this.renderMedTimes();
  },
  _medTimes:['09:00','21:00'],
  renderMedTimes(){
    document.getElementById('medTimes').innerHTML=this._medTimes.map((t,i)=>`
      <div class="time-chip"><input type="time" value="${t}" onchange="App._medTimes[${i}]=this.value">
        ${this._medTimes.length>1?`<button onclick="App._medTimes.splice(${i},1);App.renderMedTimes()">✕</button>`:''}</div>`).join('')
      + `<button class="time-add" onclick="App._medTimes.push('12:00');App.renderMedTimes()">➕</button>`;
  },
  openMedSheet(id){
    this._medEdit=id||null;
    const m=id?(this.state.meds||[]).find(x=>x.id===id):null;
    document.getElementById('medSheetTitle').textContent=m?'Editar tratamiento':'Nuevo medicamento';
    document.getElementById('medSuggest').innerHTML=this.MED_SUGGEST.map(s=>`<option value="${s}">`).join('');
    document.getElementById('medName').value=m?m.name:'';
    document.getElementById('medDose').value=m?m.dose||'':'';
    document.getElementById('medReason').value=m?m.reason||'':'';
    document.getElementById('medFreq').value=m?String((m.times||[]).length):'2';
    document.getElementById('medDays').value=m?m.days:7;
    document.getElementById('medStart').value=m?m.start:this.dateKey();
    document.getElementById('medNotify').checked=m?m.notify!==false:true;
    document.getElementById('medNotes').value=m?m.notes||'':'';
    this._medTimes=m?m.times.slice():this.medDefaultTimes(2);
    this.renderMedTimes();
    document.getElementById('medBackdrop').hidden=false;
    document.getElementById('medSheet').hidden=false;
  },
  closeMedSheet(){ document.getElementById('medBackdrop').hidden=true; document.getElementById('medSheet').hidden=true; },
  saveMed(){
    const name=document.getElementById('medName').value.trim();
    if(!name){ this.toast('Ponle nombre al medicamento 💊'); return; }
    const days=Math.max(1,+document.getElementById('medDays').value||1);
    const start=document.getElementById('medStart').value||this.dateKey();
    const times=this._medTimes.slice().sort((a,b)=>this.minOf(a)-this.minOf(b));
    if(!times.length){ this.toast('Agrega al menos un horario ⏰'); return; }
    const data={name, dose:document.getElementById('medDose').value.trim(),
      reason:document.getElementById('medReason').value.trim(),
      days, start, times, notify:document.getElementById('medNotify').checked,
      notes:document.getElementById('medNotes').value.trim()};
    if(this._medEdit){
      const m=(this.state.meds||[]).find(x=>x.id===this._medEdit);
      Object.assign(m,data);
    } else {
      this.state.meds.push({id:'m'+Date.now(), ...data, doses:{}, created:Date.now()});
    }
    this.save(); this.closeMedSheet(); this.renderMeds(); this.confetti();
    const end=new Date(this.addDays(start,days-1)+'T12:00:00');
    this.toast(`${name}: ${times.length} tomas al día hasta el ${end.toLocaleDateString('es-CL')} 💊`);
    if(data.notify) this.askNotifPermission();
    this._medEdit=null;
  },
  stopMed(id){
    const m=(this.state.meds||[]).find(x=>x.id===id); if(!m) return;
    if(!confirm(`¿Terminar el tratamiento de ${m.name} antes de tiempo?`)) return;
    m.stopped=Date.now(); this.save(); this.renderMeds();
    this.toast('Tratamiento cerrado. Queda en el historial 📋');
  },
  delMed(id){
    if(!confirm('¿Eliminar este tratamiento y su historial de tomas?')) return;
    this.state.meds=(this.state.meds||[]).filter(m=>m.id!==id); this.save(); this.renderMeds();
  },
  medDosesToday(){
    const key=this.dateKey(), out=[];
    (this.state.meds||[]).forEach(m=>{
      if(!this.medRunsOn(m,key)) return;
      m.times.forEach(t=>out.push({med:m, time:t, key, st:this.medDoseState(m,key,t)}));
    });
    return out.sort((a,b)=>this.minOf(a.time)-this.minOf(b.time));
  },
  renderMeds(){
    const list=this.state.meds||[];
    const today=this.medDosesToday();
    const pend=today.filter(d=>d.st==='due'||d.st==='pending');
    document.getElementById('medToday').innerHTML = today.length ? `
      <div class="mt-head"><span>💊</span><h4>Tomas de hoy</h4>
        <span class="mt-count">${today.filter(d=>d.st==='taken').length}/${today.length}</span></div>
      <div class="mt-rows">${today.map(d=>`
        <div class="mt-row ${d.st}">
          <span class="mt-time">${d.time}</span>
          <div class="mt-info"><p class="mt-name">${d.med.name}</p>
            <p class="mt-dose">${d.med.dose||'—'}${d.st==='due'?' · ⏰ atrasada':d.st==='taken'?' · ✅ dada':d.st==='skipped'?' · omitida':''}</p></div>
          <button class="mt-btn ${d.st==='taken'?'on':''}" onclick="App.medMark('${d.med.id}','${d.key}','${d.time}','taken')">${d.st==='taken'?'✅':'Dar'}</button>
          <button class="mt-skip" onclick="App.medMark('${d.med.id}','${d.key}','${d.time}','skipped')" title="Omitir">✕</button>
        </div>`).join('')}</div>
      ${pend.length?`<p class="mt-note">Quedan <b>${pend.length}</b> ${pend.length===1?'toma':'tomas'} hoy.</p>`:'<p class="mt-note">¡Todo al día por hoy! 🎉</p>'}`
      : `<div class="mt-empty">💊 Sin medicamentos activos hoy.<br><small>Registra un tratamiento y te aviso en cada toma.</small></div>`;

    const card=(m)=>{
      const p=this.medProgress(m), st=this.medStatus(m);
      const end=this.medEndKey(m);
      return `<div class="med-card ${st}">
        <div class="mc-head">
          <span class="mc-ico">💊</span>
          <div><p class="mc-name">${m.name}</p>
            <p class="mc-sub">${m.dose?m.dose+' · ':''}${m.times.length}×/día${m.reason?' · '+m.reason:''}</p></div>
          <span class="mc-badge ${st}">${st==='active'?`Día ${p.dayN}/${p.days}`:st==='upcoming'?'Empieza '+this.prettyDay(m.start):st==='stopped'?'Suspendido':'Terminado'}</span>
        </div>
        <div class="mc-bar"><span style="width:${p.pct}%"></span></div>
        <p class="mc-meta">${p.given} de ${p.total} tomas${p.skipped?` · ${p.skipped} omitida${p.skipped===1?'':'s'}`:''} · hasta el ${new Date(end+'T12:00:00').toLocaleDateString('es-CL')} · ⏰ ${m.times.join(' · ')}</p>
        ${m.notes?`<p class="mc-notes">📝 ${m.notes.replace(/</g,'&lt;')}</p>`:''}
        <div class="mc-actions">
          <button onclick="App.openMedSheet('${m.id}')">✏️ Editar</button>
          ${st==='active'||st==='upcoming'?`<button onclick="App.stopMed('${m.id}')">⏹️ Terminar</button>`:''}
          <button onclick="App.delMed('${m.id}')">🗑️ Eliminar</button>
        </div>
      </div>`;
    };
    const act=list.filter(m=>['active','upcoming'].includes(this.medStatus(m)));
    const fin=list.filter(m=>['done','stopped'].includes(this.medStatus(m)));
    document.getElementById('medActive').innerHTML=act.length?act.map(card).join(''):this.emptyIllu('Sin tratamientos activos.');
    document.getElementById('medDone').innerHTML=fin.length?fin.map(card).join(''):'<p class="sec-sub">Aquí quedará el historial de tratamientos.</p>';

    // calendario: próximos 7 días
    const k0=this.dateKey(); const days=[];
    for(let i=0;i<7;i++) days.push(this.addDays(k0,i));
    const rows=days.map(k=>{
      const doses=[];
      list.forEach(m=>{ if(this.medRunsOn(m,k)) m.times.forEach(t=>doses.push({m,t,st:this.medDoseState(m,k,t)})); });
      if(!doses.length) return '';
      doses.sort((a,b)=>this.minOf(a.t)-this.minOf(b.t));
      return `<div class="cal-day">
        <p class="cal-date">${this.prettyDay(k)}</p>
        <div class="cal-chips">${doses.map(d=>`
          <button class="cal-chip ${d.st}" onclick="App.medMark('${d.m.id}','${k}','${d.t}','taken')">
            ${d.st==='taken'?'✅':d.st==='skipped'?'✕':d.st==='missed'?'⚠️':d.st==='due'?'⏰':'○'} ${d.t} ${d.m.name.split(' ')[0]}
          </button>`).join('')}</div>
      </div>`;
    }).filter(Boolean).join('');
    document.getElementById('medCal').innerHTML=rows||'<p class="sec-sub">Sin tomas programadas los próximos 7 días.</p>';
  },

  /* ══════════════════════════════════════════════════════════════════════
     FICHA DEL VETERINARIO
     Se guarda por perro: cada mascota puede tener su clínica.
     ══════════════════════════════════════════════════════════════════════ */
  vetOf(){ const p=this.state.pet; return (p&&p.vet)||null; },
  telHref(n){ return 'tel:'+String(n||'').replace(/[^\d+]/g,''); },
  openVetCard(){
    const v=this.vetOf()||{};
    document.getElementById('vcName').value=v.name||'';
    document.getElementById('vcPhone').value=v.phone||'';
    document.getElementById('vcAddr').value=v.addr||'';
    document.getElementById('vcEmerg').value=v.emerg||'';
    document.getElementById('vcNotes').value=v.notes||'';
    document.getElementById('vetcBackdrop').hidden=false;
    document.getElementById('vetcSheet').hidden=false;
  },
  closeVetCard(){ document.getElementById('vetcBackdrop').hidden=true; document.getElementById('vetcSheet').hidden=true; },
  saveVetCard(){
    const g=id=>document.getElementById(id).value.trim();
    const name=g('vcName');
    if(!name){ this.toast('Ponle nombre a la clínica 🩺'); return; }
    this.state.pet.vet={name, phone:g('vcPhone'), addr:g('vcAddr'), emerg:g('vcEmerg'), notes:g('vcNotes')};
    this.save(); this.closeVetCard(); this.renderHealth(); this.renderSymptoms();
    this.toast('Ficha del veterinario guardada 🩺');
  },
  delVetCard(){
    if(!confirm('¿Borrar la ficha del veterinario?')) return;
    delete this.state.pet.vet; this.save(); this.renderHealth(); this.renderSymptoms();
  },
  // botones de llamada que aparecen cuando el cuadro pinta mal
  vetCallHTML(level){
    const v=this.vetOf();
    if(!v||(!v.phone&&!v.emerg)){
      return level==='urgent'||level==='vet'
        ? `<button class="vet-call add" onclick="App.openVetCard()">🩺 Guarda el teléfono de tu veterinario para llamarlo desde aquí</button>` : '';
    }
    const urgent=level==='urgent';
    const num=urgent&&v.emerg?v.emerg:v.phone||v.emerg;
    const label=urgent&&v.emerg?'Llamar a urgencias 24 h':`Llamar a ${v.name}`;
    return `<a class="vet-call${urgent?' urgent':''}" href="${this.telHref(num)}">📞 ${label} · ${num}</a>`;
  },
  renderVetCard(){
    const el=document.getElementById('vetCard'); if(!el) return;
    const v=this.vetOf();
    if(!v){
      el.innerHTML=`<button class="vc-empty" onclick="App.openVetCard()">
        <span>🩺</span><div><b>Agregar mi veterinario</b>
        <small>Teléfono, dirección y urgencias 24 h, a un toque cuando haga falta.</small></div><span class="tb-arrow">›</span></button>`;
      return;
    }
    el.innerHTML=`
      <div class="vc-head"><span class="vc-ico">🩺</span>
        <div><p class="vc-name">${v.name}</p>${v.addr?`<p class="vc-addr">${v.addr}</p>`:''}</div>
        <button class="vc-edit" onclick="App.openVetCard()">Editar</button></div>
      ${v.notes?`<p class="vc-notes">📝 ${v.notes.replace(/</g,'&lt;')}</p>`:''}
      <div class="vc-actions">
        ${v.phone?`<a class="vc-btn" href="${this.telHref(v.phone)}">📞 Llamar</a>`:''}
        ${v.emerg?`<a class="vc-btn urgent" href="${this.telHref(v.emerg)}">🚨 Urgencias 24 h</a>`:''}
        ${v.addr?`<a class="vc-btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.addr)}">🗺️ Cómo llegar</a>`:''}
        <button class="vc-btn ghost" onclick="App.delVetCard()">🗑️</button>
      </div>`;
  },

  /* ══════════════════════════════════════════════════════════════════════
     SACO DE ALIMENTO — cuándo se acaba, según la ración real
     ══════════════════════════════════════════════════════════════════════ */
  bagOf(){ const m=this.mealsOf(); return m.bag||null; },
  dailyGrams(){
    const m=this.mealsOf();
    if(m.grams&&m.times.length) return m.grams*m.times.length;   // lo que realmente sirve
    const r=this.rationCalc(this.state.pet);
    return r?r.grams:null;                                        // si no, la fórmula
  },
  saveBag(){
    const kg=parseFloat(document.getElementById('bagKg').value);
    const date=document.getElementById('bagDate').value||this.dateKey();
    if(!kg||kg<=0){ this.toast('¿De cuántos kilos es el saco? 🛍️'); return; }
    this.mealsOf().bag={kg, date};
    this.save(); this.renderMeals();
    const b=this.bagStatus();
    this.toast(b&&b.endKey?`Saco de ${kg} kg: rinde hasta el ${new Date(b.endKey+'T12:00:00').toLocaleDateString('es-CL')} 🛍️`:'Saco registrado 🛍️');
  },
  delBag(){ const m=this.mealsOf(); delete m.bag; this.save(); this.renderMeals(); },
  bagStatus(){
    const b=this.bagOf(); if(!b) return null;
    const gd=this.dailyGrams();
    if(!gd) return {b, unknown:true};
    const totalDays=Math.floor(b.kg*1000/gd);
    const used=Math.max(0, Math.round((new Date(this.dateKey()+'T12:00:00')-new Date(b.date+'T12:00:00'))/864e5));
    const left=totalDays-used;
    return {b, gd, totalDays, used, left, endKey:this.addDays(b.date,totalDays), pct:Math.max(0,Math.min(100,Math.round(left/totalDays*100)))};
  },
  renderBag(){
    const el=document.getElementById('bagCard'); if(!el) return;
    document.getElementById('bagDate').value=this.dateKey();
    const s=this.bagStatus();
    if(!s){
      el.innerHTML=`<div class="bag-empty">🛍️ Registra el saco que tienes abierto y te digo qué día se acaba.</div>`;
      return;
    }
    if(s.unknown){
      el.innerHTML=`<div class="bag-empty">Saco de ${s.b.kg} kg abierto el ${new Date(s.b.date+'T12:00:00').toLocaleDateString('es-CL')}. Agrega el peso de tu perro o los gramos por toma para calcular cuánto rinde.</div>`;
      return;
    }
    const cls=s.left<=0?'danger':s.left<=7?'warn':'ok';
    el.innerHTML=`
      <div class="bag-top">
        <div><p class="bag-big">${s.left>0?s.left:0}</p><p class="bag-lbl">${s.left===1?'día restante':'días restantes'}</p></div>
        <div class="bag-meta">
          <p><b>${s.b.kg} kg</b> abierto el ${new Date(s.b.date+'T12:00:00').toLocaleDateString('es-CL')}</p>
          <p>Consumo: <b>${s.gd} g/día</b> · rinde ${s.totalDays} días</p>
          <p>${s.left>0?`Se acaba el <b>${new Date(s.endKey+'T12:00:00').toLocaleDateString('es-CL',{day:'2-digit',month:'long'})}</b>`:'Debería estar terminado'}</p>
        </div>
        <button class="vi-del" onclick="App.delBag()">🗑️</button>
      </div>
      <div class="bag-bar ${cls}"><span style="width:${s.pct}%"></span></div>
      <p class="bag-hint ${cls}">${s.left<=0?'⚠️ Según el cálculo ya se acabó. Registra el saco nuevo.'
        :s.left<=7?`⏰ Compra el próximo saco esta semana.`
        :'✅ Tienes alimento de sobra por ahora.'}</p>`;
  },

  /* ══════════════════════════════════════════════════════════════════════
     RECORDATORIOS · AGENDA DEL DÍA
     La app avisa mientras está abierta o en segundo plano; al volver a abrirla
     recupera las tomas atrasadas de las últimas 3 h.
     ══════════════════════════════════════════════════════════════════════ */
  askNotifPermission(){
    if(window.Notification && Notification.permission==='default') Notification.requestPermission();
    this.nativeNotifs().then(ln=>{ if(ln) ln.requestPermissions().then(()=>this.syncNativeAlarms()); });
  },

  /* ── Alarmas nativas (APK) ───────────────────────────────────────────────
     En la app instalada usamos LocalNotifications de Capacitor: el sistema
     dispara la alarma aunque DogTalk esté cerrada. En el navegador no existe
     esa API, así que ahí manda el temporizador de checkReminders(). */
  async nativeNotifs(){
    const C=window.Capacitor;
    if(!C||!C.isNativePlatform||!C.isNativePlatform()) return null;
    return (C.Plugins&&C.Plugins.LocalNotifications)||null;
  },
  // id estable por perro+item+día+hora, para poder reprogramar sin duplicar
  _alarmId(seed){ let h=0; for(let i=0;i<seed.length;i++){ h=(h*31+seed.charCodeAt(i))|0; } return Math.abs(h%2000000000)+1; },
  async syncNativeAlarms(){
    const ln=await this.nativeNotifs(); if(!ln) return 0;
    try{
      const pend=await ln.getPending();
      if(pend&&pend.notifications&&pend.notifications.length) await ln.cancel({notifications:pend.notifications});
      const s=this.state.settings, list=[], now=Date.now(), horizon=14; // 14 días por delante
      this.state.pets.forEach(p=>{
        for(let d=0; d<horizon; d++){
          const key=this.addDays(this.dateKey(),d);
          if(s.medRem!==false) (p.meds||[]).forEach(m=>{
            if(m.notify===false||m.stopped) return;
            if(!(key>=m.start && key<=this.addDays(m.start,(+m.days||1)-1))) return;
            (m.times||[]).forEach(t=>{
              const at=new Date(key+'T'+t+':00');
              if(at.getTime()<=now) return;
              if((m.doses||{})[key+'|'+t]) return;
              list.push({id:this._alarmId(`${p.id}|${m.id}|${key}|${t}`),
                title:`💊 ${m.name} — ${p.name}`,
                body:`Toca la toma de las ${t}${m.dose?` · ${m.dose}`:''}`,
                schedule:{at}, smallIcon:'ic_stat_icon', channelId:'dogtalk-meds'});
            });
          });
          if(s.mealRem!==false && p.meals && p.meals.times){
            const lg=(p.meals.log||{})[key]||{};
            p.meals.times.forEach(t=>{
              const at=new Date(key+'T'+t+':00');
              if(at.getTime()<=now||lg[t]) return;
              list.push({id:this._alarmId(`${p.id}|meal|${key}|${t}`),
                title:`🍲 Hora de comer — ${p.name}`,
                body:`Comida de las ${t}${p.meals.grams?` · ${p.meals.grams} g`:''}`,
                schedule:{at}, smallIcon:'ic_stat_icon', channelId:'dogtalk-meals'});
            });
          }
        }
      });
      if(list.length) await ln.schedule({notifications:list.slice(0,480)}); // tope del sistema
      return list.length;
    }catch(e){ console.warn('alarmas nativas',e); return 0; }
  },
  startReminders(){
    if(this._remTimer) clearInterval(this._remTimer);
    this._remTimer=setInterval(()=>this.checkReminders(), 30000);
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden) this.checkReminders(); });
    this.checkReminders();
  },
  checkReminders(){
    if(!this.state.pets||!this.state.pets.length) return;
    const now=new Date(), key=this.dateKey(now), nowMin=now.getHours()*60+now.getMinutes();
    const fired=this.state.remFired=this.state.remFired||{};
    const s=this.state.settings; let dirty=false;
    const WINDOW=180; // avisamos hasta 3 h después de la hora programada
    this.state.pets.forEach(p=>{
      if(s.medRem!==false) (p.meds||[]).forEach(m=>{
        if(m.notify===false || m.stopped) return;
        if(!(key>=m.start && key<=this.addDays(m.start,(+m.days||1)-1))) return;
        (m.times||[]).forEach(t=>{
          const id=`${p.id}|${m.id}|${key}|${t}`;
          if(fired[id]) return;
          const tm=this.minOf(t);
          if(nowMin>=tm && nowMin-tm<=WINDOW && !((m.doses||{})[key+'|'+t])){
            fired[id]=Date.now(); dirty=true;
            this.notify(`💊 ${m.name} — ${p.name}`, `Toca la toma de las ${t}${m.dose?` · ${m.dose}`:''}`);
            this.toast(`💊 ${p.name}: toca ${m.name} (${t})`);
          }
        });
      });
      if(s.mealRem!==false && p.meals && p.meals.times){
        const lg=(p.meals.log||{})[key]||{};
        p.meals.times.forEach(t=>{
          const id=`${p.id}|meal|${key}|${t}`;
          if(fired[id]) return;
          const tm=this.minOf(t);
          if(nowMin>=tm && nowMin-tm<=90 && !lg[t]){
            fired[id]=Date.now(); dirty=true;
            this.notify(`🍲 Hora de comer — ${p.name}`, `Comida de las ${t}${p.meals.grams?` · ${p.meals.grams} g`:''}`);
          }
        });
      }
    });
    // limpieza: solo guardamos los avisos de los últimos 3 días
    const cut=Date.now()-3*864e5;
    Object.keys(fired).forEach(k=>{ if(fired[k]<cut){ delete fired[k]; dirty=true; } });
    if(dirty) this.save();
    if(document.getElementById('screen-home').classList.contains('active')) this.renderAgenda();
  },
  renderAgenda(){
    const el=document.getElementById('agendaCard'); if(!el) return;
    const items=[];
    const now=new Date(), nowMin=now.getHours()*60+now.getMinutes(), key=this.dateKey();
    this.medDosesToday().filter(d=>d.st!=='taken'&&d.st!=='skipped').forEach(d=>items.push({
      min:this.minOf(d.time), ico:'💊', title:`${d.med.name}${d.med.dose?' · '+d.med.dose:''}`,
      time:d.time, late:d.st==='due',
      action:`App.medMark('${d.med.id}','${d.key}','${d.time}','taken')`, btn:'Dar'
    }));
    const m=this.mealsOf(); const lg=(m.log||{})[key]||{};
    (m.times||[]).filter(t=>!lg[t]).forEach(t=>items.push({
      min:this.minOf(t), ico:'🍲', title:'Comida', time:t, late:this.minOf(t)<nowMin,
      action:`App.toggleMealDone('${t}')`, btn:'Listo'
    }));
    const vs=(this.state.vaccines||[]).map(v=>({v,n:this.vacNextDate(v)}))
      .filter(x=>x.n&&x.n-Date.now()<7*864e5&&x.n-Date.now()>-30*864e5);
    vs.forEach(x=>items.push({min:1e6, ico:'💉', title:`${this.vacLabel(x.v.type)} — ${new Date(x.n).toLocaleDateString('es-CL')}`,
      time:'', late:x.n<Date.now(), action:`App.go('health')`, btn:'Ver'}));
    if(!items.length){ el.hidden=true; return; }
    items.sort((a,b)=>a.min-b.min);
    el.hidden=false;
    document.getElementById('agendaList').innerHTML=items.slice(0,5).map(i=>`
      <div class="ag-row ${i.late?'late':''}">
        <span class="ag-ico">${i.ico}</span>
        <div class="ag-info"><p class="ag-title">${i.title}</p>
          <p class="ag-time">${i.time?`${i.time}${i.late?' · atrasado':''}`:'próximamente'}</p></div>
        <button class="ag-btn" onclick="${i.action}">${i.btn}</button>
      </div>`).join('');
  },

  /* ══════════════════════════════════════════════════════════════════════
     FALSOS POSITIVOS — "no era mi perro"
     El evento sale de las estadísticas y sube el umbral de esa clase de sonido.
     ══════════════════════════════════════════════════════════════════════ */
  _fpTarget:null,
  openFpSheet(id){
    this._fpTarget=id;
    document.getElementById('fpGrid').innerHTML=Object.entries(this.FP_REASONS).map(([k,r])=>
      `<button class="label-btn" onclick="App.rejectEvent('${k}')">${r.e}<span>${r.l}</span></button>`).join('');
    document.getElementById('fpBackdrop').hidden=false;
    document.getElementById('fpSheet').hidden=false;
  },
  closeFpSheet(){ document.getElementById('fpBackdrop').hidden=true; document.getElementById('fpSheet').hidden=true; },
  rejectEvent(reason){
    const i=this.state.events.findIndex(e=>e.id===this._fpTarget);
    if(i<0){ this.closeFpSheet(); return; }
    const e=this.state.events.splice(i,1)[0];
    e.fp=reason; e.fpAt=Date.now();
    (this.state.rejected=this.state.rejected||[]).push(e);
    // aprendizaje: subimos el umbral de la clase acústica que se equivocó
    const cls=e.cls||e.type;
    const fp=this.state.fpCount=this.state.fpCount||{};
    fp[cls]=(fp[cls]||0)+1;
    this.save();
    this.closeFpSheet();
    this.renderHome();
    if(document.getElementById('screen-history').classList.contains('active')) this.renderHistory(this._histFilter||'todos');
    const extra=this.fpBoost(cls);
    this.toast(`Aprendido: ${this.FP_REASONS[reason].l}. Umbral de ese sonido +${Math.round(extra*100)}% 🎯`);
  },
  restoreEvent(id){
    const i=(this.state.rejected||[]).findIndex(e=>e.id===id);
    if(i<0) return;
    const e=this.state.rejected.splice(i,1)[0];
    const cls=e.cls||e.type;
    if(this.state.fpCount&&this.state.fpCount[cls]) this.state.fpCount[cls]--;
    delete e.fp; delete e.fpAt;
    this.state.events.push(e);
    this.state.events.sort((a,b)=>a.ts-b.ts);
    this.save(); this.renderHistory('descartados'); this.toast('Evento restaurado ↩️');
  },
  fpBoost(cls){ return Math.min(0.18, 0.04*((this.state.fpCount||{})[cls]||0)); },
  baseThreshold(){
    return ({alta:0.22, media:0.32, baja:0.45})[this.state.settings.sensitivity||'media'];
  },
  setSensitivity(v){
    this.state.settings.sensitivity=v; this.save();
    document.querySelectorAll('#setSens .chip').forEach(c=>c.classList.toggle('sel',c.dataset.v===v));
    this.toast(v==='baja'?'Solo se registrarán sonidos muy claros 🔇':v==='alta'?'Máxima sensibilidad: puede haber falsos positivos 🔊':'Sensibilidad equilibrada 🎚️');
  },

  /* ══════════════════════════════════════════════════════════════════════
     MICRÓFONO ACTIVO — aviso visible en la pestaña y en la bandeja
     ══════════════════════════════════════════════════════════════════════ */
  micIndicator(on){
    const bar=document.getElementById('micBar');
    if(on){
      if(bar) bar.hidden=false;
      document.body.classList.add('mic-on');
      if(!this._titleTimer){
        this._baseTitle=this._baseTitle||document.title;
        let flip=false;
        this._titleTimer=setInterval(()=>{
          flip=!flip;
          document.title = flip ? '🔴 Micrófono ENCENDIDO · DogTalk' : '🎙️ Escuchando a tu perro…';
        }, 1500);
      }
      this._persistNotif(true);
      if(!this._beforeUnload){
        this._beforeUnload=(e)=>{ if(this.listening){ e.preventDefault(); e.returnValue=''; } };
        window.addEventListener('beforeunload', this._beforeUnload);
      }
    } else {
      if(bar) bar.hidden=true;
      document.body.classList.remove('mic-on');
      if(this._titleTimer){ clearInterval(this._titleTimer); this._titleTimer=null; }
      document.title=this._baseTitle||'DogTalk AI — Traductor de ladridos';
      this._persistNotif(false);
    }
  },
  _persistNotif(on){
    if(!window.Notification || Notification.permission!=='granted') return;
    const opts={ body:'DogTalk está escuchando a tu perro. Toca para volver y detenerlo.',
      tag:'dogtalk-mic', icon:'icon-192.png', badge:'icon-192.png', requireInteraction:true, silent:true };
    if(navigator.serviceWorker && navigator.serviceWorker.ready){
      navigator.serviceWorker.ready.then(reg=>{
        if(on) reg.showNotification('🔴 Micrófono encendido', opts);
        else reg.getNotifications({tag:'dogtalk-mic'}).then(ns=>ns.forEach(n=>n.close()));
      }).catch(()=>{});
    } else if(on){
      try{ this._micNotif=new Notification('🔴 Micrófono encendido', opts); }catch(e){}
    } else if(this._micNotif){ this._micNotif.close(); this._micNotif=null; }
  },

  /* ══════════════════════════════════════════════════════════════════════
     CUENTA LOCAL Y PRUEBA GRATIS DE 1 DÍA
     ⚠️ El login es local (localStorage) y decorativo: no hay servidor que
     valide nada. Sirve para separar perfiles en el dispositivo, no como
     medida de seguridad real.
     ══════════════════════════════════════════════════════════════════════ */
  DEMO_USER:{email:'t.callealta@gmail.com', name:'Tomás Callealta', pass:'123456', plan:'familiar'},
  TRIAL_MS:864e5, // 24 horas
  h32(s){ let h=0x811c9dc5; for(let i=0;i<String(s).length;i++){ h^=String(s).charCodeAt(i); h=Math.imul(h,0x01000193)>>>0; } return h.toString(16); },
  seedDemo(){
    this.state.users=this.state.users||{};
    const d=this.DEMO_USER;
    if(!this.state.users[d.email]){
      this.state.users[d.email]={name:d.name, ph:this.h32(d.pass), plan:d.plan, created:Date.now(), trialStart:null};
      this.save();
    }
  },
  isPro(){ return this.state.plan==='premium'||this.state.plan==='familiar'; },
  trialLeft(){ if(!this.state.trialStart) return this.TRIAL_MS; return Math.max(0, this.state.trialStart+this.TRIAL_MS-Date.now()); },
  trialExpired(){ return !this.isPro() && this.trialLeft()<=0; },
  trialLabel(){
    const ms=this.trialLeft();
    if(ms<=0) return 'Prueba terminada';
    const h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
    return h>0?`${h} h ${m} min`:`${m} min`;
  },
  _loginMode:'login',
  swapLoginMode(){
    this._loginMode = this._loginMode==='login'?'signup':'login';
    const s=this._loginMode==='signup';
    document.getElementById('logTitle').textContent=s?'Crear cuenta':'Entrar';
    document.getElementById('logBtn').textContent=s?'Crear cuenta y probar gratis':'Entrar';
    document.getElementById('logSwap').textContent=s?'Ya tengo cuenta':'Crear una cuenta nueva';
    document.getElementById('logNameWrap').hidden=!s;
  },
  doLogin(){
    const mail=document.getElementById('logMail').value.trim().toLowerCase();
    const pass=document.getElementById('logPass').value;
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)){ this.toast('Escribe un correo válido 📧'); return; }
    if(pass.length<6){ this.toast('La contraseña necesita al menos 6 caracteres 🔒'); return; }
    this.state.users=this.state.users||{};
    const u=this.state.users[mail];
    if(this._loginMode==='signup'){
      if(u){ this.toast('Ese correo ya tiene cuenta aquí. Entra con tu contraseña.'); return; }
      const name=document.getElementById('logName').value.trim()||mail.split('@')[0];
      this.state.users[mail]={name, ph:this.h32(pass), plan:'free', created:Date.now(), trialStart:Date.now()};
    } else {
      if(!u){ this.toast('No hay cuenta con ese correo en este dispositivo 🤔'); return; }
      if(u.ph!==this.h32(pass)){ this.toast('Contraseña incorrecta 🔒'); return; }
      if(u.plan!=='premium'&&u.plan!=='familiar'&&!u.trialStart) u.trialStart=Date.now();
    }
    const usr=this.state.users[mail];
    this.state.session=mail;
    this.state.plan=usr.plan;
    this.state.trialStart=usr.trialStart;
    this.state.account={...(this.state.account||{}), name:usr.name, email:mail,
      card:(this.state.account||{}).card||null, autoRenew:true, since:usr.created, invoices:(this.state.account||{}).invoices||[]};
    this.save();
    this.confetti();
    this.toast(this.isPro()?`¡Hola ${usr.name}! Plan ${this.PLANS[usr.plan].name} activo ⭐`:`¡Bienvenido! Tienes 24 h de prueba gratis 🎁`);
    this.state.pet ? this.go('home') : this.go('petform');
    this.renderTrial();
  },
  logout(){
    if(!confirm('¿Cerrar sesión? Los datos de tus perros quedan en este dispositivo.')) return;
    this.state.session=null; this.save();
    document.getElementById('logPass').value='';
    this.go('login');
  },
  changePassword(){
    const mail=this.state.session;
    if(!mail){ this.toast('Primero inicia sesión'); return; }
    const cur=prompt('Contraseña actual:'); if(cur===null) return;
    if(this.state.users[mail].ph!==this.h32(cur)){ this.toast('Contraseña incorrecta 🔒'); return; }
    const nw=prompt('Nueva contraseña (mínimo 6 caracteres):'); if(nw===null) return;
    if(nw.length<6){ this.toast('Muy corta, mínimo 6 caracteres'); return; }
    this.state.users[mail].ph=this.h32(nw); this.save();
    this.toast('Contraseña actualizada 🔒');
  },
  syncUserPlan(){
    const mail=this.state.session;
    if(mail&&this.state.users&&this.state.users[mail]){
      this.state.users[mail].plan=this.state.plan;
      this.state.users[mail].trialStart=this.state.trialStart;
    }
  },
  // pantallas que exigen plan pagado (usan micrófono, cámara o modelos de IA)
  PRO_SCREENS:['listen','translate','camera','absence','wrapped'],
  FREE_ALWAYS:['onboarding','login','petform','home','subscription','account','settings'],
  gate(name){
    if(this.isPro()) return true;
    if(this.PRO_SCREENS.includes(name)){ this.paywall('pro'); return false; }
    if(this.trialExpired() && !this.FREE_ALWAYS.includes(name)){ this.paywall('trial'); return false; }
    return true;
  },
  requirePro(what){
    if(this.isPro()) return true;
    this.paywall('pro', what);
    return false;
  },
  paywall(kind, what){
    if(kind==='pro') this.toast(`🎙️ ${what||'La escucha con IA'} es parte de Premium. La prueba gratis registra eventos y salud.`);
    else this.toast('Tu prueba gratis de 1 día terminó ⏳ Activa un plan para seguir.');
    this.go('subscription');
  },
  renderTrial(){
    const el=document.getElementById('trialBanner'); if(!el) return;
    if(this.isPro()){ el.hidden=true; return; }
    el.hidden=false;
    const left=this.trialLeft();
    el.className='trial-banner'+(left<=0?' over':left<6*36e5?' soon':'');
    el.innerHTML = left>0
      ? `<span class="tb-ico">🎁</span><div><b>Prueba gratis · quedan ${this.trialLabel()}</b>
         <small>Incluye eventos, salud, comidas, peso y medicamentos. La escucha con IA es Premium.</small></div><span class="tb-arrow">›</span>`
      : `<span class="tb-ico">⏳</span><div><b>Tu prueba de 1 día terminó</b>
         <small>Activa Premium o Familiar para seguir usando DogTalk.</small></div><span class="tb-arrow">›</span>`;
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
    document.getElementById('symPhotoFile').addEventListener('change',e=>{
      const f=e.target.files[0]; if(f) this.addSymPhoto(f); e.target.value='';
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
    sn.onchange=()=>{this.state.settings.notif=sn.checked; this.save(); if(sn.checked) this.askNotifPermission();};
    sa.onchange=()=>{this.state.settings.autoListen=sa.checked; this.save();};
    const sm=document.getElementById('setMedRem'), sf=document.getElementById('setMealRem');
    sm.checked=this.state.settings.medRem!==false; sf.checked=this.state.settings.mealRem!==false;
    sm.onchange=()=>{this.state.settings.medRem=sm.checked; this.save(); if(sm.checked) this.askNotifPermission();};
    sf.onchange=()=>{this.state.settings.mealRem=sf.checked; this.save(); if(sf.checked) this.askNotifPermission();};
    // sensibilidad de detección (contra falsos positivos)
    const sens=document.getElementById('setSens');
    if(sens){
      sens.querySelectorAll('.chip').forEach(c=>c.classList.toggle('sel', c.dataset.v===(this.state.settings.sensitivity||'media')));
      sens.addEventListener('click',e=>{ if(e.target.classList.contains('chip')) this.setSensitivity(e.target.dataset.v); });
    }
    // sheets de síntomas: hora personalizada
    const sw=document.getElementById('symWhen');
    if(sw) sw.addEventListener('click',e=>{
      if(!e.target.classList.contains('chip')) return;
      const cst=document.getElementById('symWhenCustom');
      cst.hidden = e.target.dataset.v!=='custom';
      if(!cst.hidden && !cst.value){
        const n=new Date(); n.setMinutes(n.getMinutes()-n.getTimezoneOffset());
        cst.value=n.toISOString().slice(0,16);
      }
    });
    // mascota interactiva
    const mascot=document.getElementById('mascot');
    if(mascot) mascot.addEventListener('click',()=>{
      mascot.classList.remove('happy'); void mascot.offsetWidth; mascot.classList.add('happy');
      this.confetti();
      this.toast(['¡Guau guau! 🐾','¡Woof! ❤️','*mueve la cola* 🐕','¡Arf arf! 🎾'][Math.floor(Math.random()*4)]);
    });
    // pantalla inicial
    if(this.state.pet){
      // precargar formulario para edición
      const p=this.state.pet;
      document.getElementById('petName').value=p.name||'';
      document.getElementById('petBreed').value=p.breed||'';
      document.getElementById('petBirth').value=p.birth||'';
      document.getElementById('petAgeY').value=p.ageY!=null?p.ageY:'';
      document.getElementById('petAgeM').value=p.ageM!=null?p.ageM:'';
      document.getElementById('petWeight').value=p.weight||'';
      document.getElementById('petMedical').value=p.medical||'';
      ['petSex','petActivity','petNeutered'].forEach(g=>{
        const v={petSex:p.sex, petActivity:p.activity, petNeutered:p.neutered}[g];
        document.querySelectorAll(`#${g} .chip`).forEach(c=>c.classList.toggle('sel', c.dataset.v===v));
      });
      p.birth ? this.onBirthChange() : this.onManualAge();
      if(p.photo) document.getElementById('photoPicker').innerHTML=`<img src="${p.photo}">`;
    }
    // sesión: sin cuenta iniciada mostramos el login
    if(this.state.session && this.state.users[this.state.session]){
      const u=this.state.users[this.state.session];
      this.state.plan=u.plan; this.state.trialStart=u.trialStart;
      document.getElementById('logMail').value=this.state.session;
      this.state.pet ? this.go('home') : this.go('petform');
    } else if(this.state.pet){
      document.getElementById('logMail').value=(this.state.account||{}).email||'';
      this.go('login');
    }
    this.startReminders();
    this.syncNativeAlarms();
    // el banner de prueba se refresca cada minuto
    setInterval(()=>{ if(document.getElementById('screen-home').classList.contains('active')) this.renderTrial(); }, 60000);
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
