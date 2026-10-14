/* ==========================================================================
   ENGINE() — arena.html-compatible framework
   Replace ONLY the `function ENGINE(){...}` block in arena.html with this.
   Sections marked  [CUSTOMIZE]  are where your own logic goes.
   Fully self-contained: no outside references, no DOM, no imports.
   ========================================================================== */
function ENGINE(){
  /* ---------- 1. Constants ------------------------------------------------ */
  const W=10, H=40, TOP=20, FULL=(1<<W)-1, SPY=TOP-2;
  const ATK_R=2.5;                       // attack -> score scale for appOnly

  /* ---------- 2. Piece model ----------------------------------------------
     ids: 1=I 2=J 3=L 4=O 5=S 6=T 7=Z.  Origin = top-left of bounding box,
     y grows downward.  n = bounding-box size, c = spawn cells [x0,y0,...].   */
  const BASE=[null,
    {n:4,c:[0,1, 1,1, 2,1, 3,1]},        // I
    {n:3,c:[0,0, 0,1, 1,1, 2,1]},        // J
    {n:3,c:[2,0, 0,1, 1,1, 2,1]},        // L
    {n:2,c:[0,0, 1,0, 0,1, 1,1]},        // O
    {n:3,c:[1,0, 2,0, 0,1, 1,1]},        // S
    {n:3,c:[1,0, 0,1, 1,1, 2,1]},        // T
    {n:3,c:[0,0, 1,0, 1,1, 2,1]}         // Z
  ];
  const SH=[null];
  for(let id=1;id<=7;id++){
    const {n,c}=BASE[id]; let cur=c.slice(); const rots=[];
    for(let r=0;r<4;r++){
      rots.push(Int8Array.from(cur));
      const nx=[];                        // rotate CW inside the n x n box
      for(let i=0;i<8;i+=2) nx.push(n-1-cur[i+1], cur[i]);
      cur=nx;
    }
    SH.push(rots);
  }
  const SPX=[0,3,3,3,4,3,3,3];            // spawn column per piece id

  /* SRS kick tables, written y-UP as in the wiki; converted (dy = -ky) on use.
     Key = from-rotation then to-rotation.  [CUSTOMIZE] swap in other kicks.   */
  const K3={'01':[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],'10':[[0,0],[1,0],[1,-1],[0,2],[1,2]],
            '12':[[0,0],[1,0],[1,-1],[0,2],[1,2]],'21':[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
            '23':[[0,0],[1,0],[1,1],[0,-2],[1,-2]],'32':[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
            '30':[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],'03':[[0,0],[1,0],[1,1],[0,-2],[1,-2]]};
  const KI={'01':[[0,0],[-2,0],[1,0],[-2,-1],[1,2]],'10':[[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
            '12':[[0,0],[-1,0],[2,0],[-1,2],[2,-1]],'21':[[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
            '23':[[0,0],[2,0],[-1,0],[2,1],[-1,-2]],'32':[[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
            '30':[[0,0],[1,0],[-2,0],[1,-2],[-2,1]],'03':[[0,0],[-1,0],[2,0],[-1,2],[2,-1]]};
  const K180=[[0,0],[0,1],[1,0],[-1,0]];

  /* ---------- 3. PRNG / bag ----------------------------------------------- */
  function rng32(seed){
    let a=seed>>>0;
    return ()=>{
      a=(a+0x6D2B79F5)>>>0; let t=a;
      t=Math.imul(t^(t>>>15),t|1);
      t^=t+Math.imul(t^(t>>>7),t|61);
      return ((t^(t>>>14))>>>0)/4294967296;
    };
  }
  function Bag(seed){
    const r=rng32(seed); let b=[];
    return ()=>{
      if(!b.length){
        b=[1,2,3,4,5,6,7];
        for(let i=6;i>0;i--){const j=(r()*(i+1))|0; const t=b[i]; b[i]=b[j]; b[j]=t;}
      }
      return b.pop();
    };
  }
  function gauss(){                       // local noise source (Box-Muller)
    let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  }

  /* ---------- 4. Collision ------------------------------------------------ */
  function collide(board,id,r,x,y){
    const k=SH[id][r];
    for(let c=0;c<8;c+=2){
      const X=x+k[c], Y=y+k[c+1];
      if(X<0||X>=W||Y>=H) return true;
      if(Y>=0 && ((board[Y]>>X)&1)) return true;     // Y<0 counts as empty
    }
    return false;
  }

  /* ---------- 5. Spin detection ------------------------------------------
     0 none, 1 mini, 2 full.  Called BEFORE the piece is written.
     [CUSTOMIZE] change T-spin / all-spin rules here.                        */
  function spinOf(board,id,r,x,y,rotated,fifthKick,allMini){
    if(!rotated || id===4) return 0;
    if(id===6){                                       // T: 3-corner rule
      const occ=(cx,cy)=>cx<0||cx>=W||cy>=H||(cy>=0&&((board[cy]>>cx)&1)===1);
      const a=occ(x,y), b=occ(x+2,y), c=occ(x,y+2), d=occ(x+2,y+2);
      if(+a+ +b+ +c+ +d<3) return 0;
      const front=[[a,b],[b,d],[c,d],[a,c]][r];       // the two corners the T points at
      return (front[0]&&front[1])||fifthKick ? 2 : 1;
    }
    // other pieces: immobile (cannot move left/right/up) => spin
    if(collide(board,id,r,x-1,y)&&collide(board,id,r,x+1,y)&&collide(board,id,r,x,y-1))
      return allMini?1:2;
    return 0;
  }

  /* ---------- 6. Attack table --------------------------------------------
     Writes into shared AO and returns it.  [CUSTOMIZE] tune freely.         */
  const AO=[0,0,0];
  const LINE_ATK=[0,0,1,2,4], SPIN_FULL=[0,2,4,6,8], SPIN_MINI=[0,0,1,2,3];
  const COMBO_ATK=[0,0,1,1,2,2,3,3,4,4,5];
  function attackOf(lines,spin,b2b,combo,perfectClear){
    const hard=(lines===4||spin>0);
    const nb2b=hard?b2b+1:-1;
    const ncombo=combo+1;
    let a=spin===2?SPIN_FULL[lines]:spin===1?SPIN_MINI[lines]:LINE_ATK[lines];
    if(nb2b>=1) a+=1;
    a+=COMBO_ATK[Math.min(ncombo,COMBO_ATK.length-1)];
    if(perfectClear) a=10;
    AO[0]=a; AO[1]=nb2b; AO[2]=ncombo;
    return AO;
  }

  /* ---------- 7. Brain weights -------------------------------------------
     KEYS.length MUST equal DEF.length, and brains must match this length.
     Penalties are negative weights.  [CUSTOMIZE]                            */
  const KEYS=['holes','bump','aggH','maxH','rowTrans','wells','danger',
              'lines','atk','spin','b2b','combo','pc'];
  const DEF=[-6,-0.6,-0.35,-0.4,-0.5,-0.3,-1.5,
              0.5,3,2.5,1,0.4,20];

  /* ---------- 8. Simulation of one lock ----------------------------------
     Mirrors what the arena does: write, clear, attack, top-out checks.      */
  function sim(board,id,f,b2b,combo,allMini){
    const k=SH[id][f.r];
    let above=false, visible=false;
    for(let c=0;c<8;c+=2){
      const Y=f.y+k[c+1];
      if(Y<0) above=true;
      if(Y>=TOP) visible=true;
    }
    if(above||!visible) return {dead:true};
    const spin=spinOf(board,id,f.r,f.x,f.y,f.v>0,f.v===2,allMini);
    const nb=Int32Array.from(board);
    for(let c=0;c<8;c+=2) nb[f.y+k[c+1]]|=1<<(f.x+k[c]);
    let w=H-1, lines=0;
    for(let r=H-1;r>=0;r--){ if(nb[r]===FULL) lines++; else nb[w--]=nb[r]; }
    while(w>=0) nb[w--]=0;
    let pc=false;
    if(lines>0){ pc=true; for(let r=H-1;r>=H-4;r--) if(nb[r]!==0){pc=false;break;} }
    let atk=0, nb2b=b2b, ncombo=-1;
    if(lines>0){ const a=attackOf(lines,spin,b2b,combo,pc); atk=a[0]; nb2b=a[1]; ncombo=a[2]; }
    return {dead:false,board:nb,lines,spin,pc,atk,b2b:nb2b,combo:ncombo};
  }

  /* ---------- 9. Board evaluation ----------------------------------------
     [CUSTOMIZE] this is the heart of your bot: features -> weighted score.  */
  const HGT=new Int32Array(W), F=new Float64Array(13);
  function feats(res){                                // 13 features, KEYS order
    const nb=res.board;
    let holes=0, maxH=0, aggH=0, bump=0, rowT=0, wells=0, wellMax=0;
    for(let x=0;x<W;x++){
      let h=0, seen=false;
      for(let y=0;y<H;y++){
        if((nb[y]>>x)&1){ if(!seen){seen=true;h=H-y;} }
        else if(seen) holes++;
      }
      HGT[x]=h; aggH+=h; if(h>maxH) maxH=h;
    }
    for(let x=0;x<W-1;x++) bump+=Math.abs(HGT[x]-HGT[x+1]);
    for(let x=0;x<W;x++){
      const l=x>0?HGT[x-1]:99, r=x<W-1?HGT[x+1]:99;
      const d=Math.min(l,r)-HGT[x];
      if(d>0){ wells+=d; if(d>wellMax) wellMax=d; }
    }
    wells-=wellMax;                                   // one deep well is allowed
    for(let y=0;y<H;y++){
      const m=nb[y]; if(!m) continue;
      const ext=(m<<1)|1|(1<<11);
      let d=(ext^(ext>>1))&0x7FF, n=0;
      while(d){ d&=d-1; n++; }
      rowT+=n;
    }
    const danger=maxH>12?(maxH-12)*(maxH-12):0;
    F[0]=holes;F[1]=bump;F[2]=aggH;F[3]=maxH;F[4]=rowT;F[5]=wells;F[6]=danger;
    F[7]=res.lines;F[8]=res.atk;F[9]=res.spin;F[10]=res.b2b>=1?1:0;F[11]=Math.min(res.combo,8);F[12]=res.pc?1:0;
    return F;
  }
  function reward(res,w,appOnly){
    if(res.dead) return -1e9;
    feats(res); let s=0;
    for(let i=0;i<7;i++) s+=w[i]*F[i];
    if(appOnly) return s+res.atk*ATK_R;               // attack-only reward mode
    for(let i=7;i<13;i++) s+=w[i]*F[i];
    return s;
  }

  /* ---------- 10. Placement search ---------------------------------------
     BFS over (x,y,r,v) with moves L/R/down/CW/CCW/180.  v: 0 plain,
     1 last move was a rotation, 2 rotation using the 5th kick.
     Path codes: 0=L 1=R 2=down 3=CW 4=CCW 5=180 6=hard drop.
     [CUSTOMIZE] replace with your own move generator if you have one.       */
  const KEYN=(H+8)*20*4*3;
  const key=(x,y,r,v)=>((((y+4)*20+(x+4))*4+r)*3+v);
  function tryRotate(board,id,r,x,y,d){
    if(id===4) return null;                           // O: rotation is a no-op
    const nr=(r+d)&3;
    const kicks=d===2?K180:(id===1?KI:K3)[''+r+nr];
    for(let i=0;i<kicks.length;i++){
      const nx=x+kicks[i][0], ny=y-kicks[i][1];
      if(ny<-3) continue;
      if(!collide(board,id,nr,nx,ny))
        return {x:nx,y:ny,r:nr,v:(i===4&&d!==2)?2:1};
    }
    return null;
  }
  function enumerate(board,id,tucks,wantPath){
    const out=[];
    if(collide(board,id,0,SPX[id],SPY)) return out;
    const sx=[SPX[id]],sy=[SPY],sr=[0],sv=[0],sp=[-1],sm=[-1];
    const seen=new Uint8Array(KEYN), fin=new Uint8Array(KEYN);
    seen[key(SPX[id],SPY,0,0)]=1;
    const pathOf=i=>{
      const p=[]; for(;i>0;i=sp[i]) p.push(sm[i]); p.reverse(); p.push(6); return p;
    };
    const emit=(f,i)=>{
      const kk=key(f.x,f.y,f.r,f.v); if(fin[kk]) return; fin[kk]=1;
      out.push({f,path:wantPath?pathOf(i):null});
    };
    const push=(x,y,r,v,p,m)=>{
      const kk=key(x,y,r,v); if(seen[kk]) return; seen[kk]=1;
      sx.push(x);sy.push(y);sr.push(r);sv.push(v);sp.push(p);sm.push(m);
    };
    for(let i=0;i<sx.length;i++){
      const x=sx[i],y=sy[i],r=sr[i],v=sv[i];
      if(tucks){
        if(collide(board,id,r,x,y+1)) emit({x,y,r,v},i);
      }else{
        let y2=y; while(!collide(board,id,r,x,y2+1)) y2++;
        emit({x,y:y2,r,v:y2===y?v:0},i);
      }
      if(!collide(board,id,r,x-1,y)) push(x-1,y,r,0,i,0);
      if(!collide(board,id,r,x+1,y)) push(x+1,y,r,0,i,1);
      if(tucks && !collide(board,id,r,x,y+1)) push(x,y+1,r,0,i,2);
      const ds=[1,3,2];
      for(let j=0;j<3;j++){
        const t=tryRotate(board,id,r,x,y,ds[j]);
        if(t) push(t.x,t.y,t.r,t.v,i,j===0?3:j===1?4:5);
      }
    }
    return out;
  }

  /* ---------- 11. planPath (called once per piece, inside the worker) ----- */
  function planPath(st,w,o){
    o=o||{};
    const board=Int32Array.from(st.board);
    const q=st.queue, tucks=o.tucks!==false, allMini=!!o.allMini, appOnly=!!o.appOnly;
    // Hold options. Empty hold + hold => placed piece is queue[0].
    const opts=[{hold:false,id:st.cur,next:q[0],nh:st.hold}];
    if(o.useHold!==false && st.canHold){
      if(st.hold) opts.push({hold:true,id:st.hold,next:q[0],nh:st.cur});
      else if(q.length>0) opts.push({hold:true,id:q[0],next:q[1],nh:st.cur});
    }
    // Ply 1
    const cands=[];
    for(const op of opts){
      for(const p of enumerate(board,op.id,tucks,true)){
        const res=sim(board,op.id,p.f,st.b2b,st.combo,allMini);
        cands.push({op,p,res,sc:reward(res,w,appOnly),total:0});
      }
    }
    if(!cands.length) return null;
    cands.sort((a,b)=>b.sc-a.sc);
    // Ply 2 on the top `look` candidates
    const n=Math.min(o.look||6,cands.length);
    for(let i=0;i<n;i++){
      const c=cands[i];
      if(c.res.dead){ c.total=-1e9; continue; }
      let best=-Infinity, any=false;
      const nxt=[]; if(c.op.next) nxt.push(c.op.next);
      if(c.op.nh && c.op.nh!==c.op.next) nxt.push(c.op.nh);
      for(const pid of nxt){
        any=true;
        for(const p of enumerate(c.res.board,pid,tucks,false)){
          const r2=sim(c.res.board,pid,p.f,c.res.b2b,c.res.combo,allMini);
          const s2=reward(r2,w,appOnly); if(s2>best) best=s2;
        }
      }
      if(!any) best=0; else if(best===-Infinity) best=-1e9;
      c.total=c.sc+0.9*best;
    }
    // Choose: noise on totals, or a random top-6 "mistake"
    let pick=null;
    if(o.mistake && Math.random()<o.mistake){
      const pool=cands.slice(0,6).filter(c=>!c.res.dead);
      if(pool.length) pick=pool[(Math.random()*pool.length)|0];
    }
    if(!pick){
      let bs=-Infinity;
      for(let i=0;i<n;i++){
        const s=cands[i].total+(o.noise?gauss()*o.noise:0);
        if(s>bs){bs=s;pick=cands[i];}
      }
    }
    return {useHold:pick.op.hold, id:pick.op.id, f:pick.p.f, path:pick.p.path};
  }

  /* ---------- 12. Exports (all required by arena.html) -------------------- */
  return { W,H,TOP,FULL,SPY,SH,SPX,
           collide,spinOf,attackOf,AO,
           Bag,rng32,planPath,
           KEYS,DEF,
           sim,enumerate,feats,reward };   // extras: ignored by arena.html, used by index.html
}
