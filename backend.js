'use strict';
// Money Tracker - runs fully in the browser. Each user signs in with Google;
// data lives in a spreadsheet created in THEIR OWN Drive (scope: drive.file).
const SCOPE='https://www.googleapis.com/auth/drive.file';
const SHEET_TITLE='MONEY TRACKER DATA';
const HDFC_ACCOUNT='HDFC', HDFC_LIMIT=8000;   // optional deposit-limit warning, only if an account is named HDFC
const AUTO_NOTE='Auto-pay (auto-processed)';
const SH='https://sheets.googleapis.com/v4/spreadsheets';
const SID_OF={'MONEY TRACKER':1,'ENTRIES':2,'BUDGETS':3,'OPENING BALANCE':4,'AUTOPAY':5};
let tok=null,tokExp=0,tokenClient=null,pendingAuth=[],SID=localStorage.getItem('mt_sheet_id')||'';
let DATA=null,DATA_T=0,dirty=true,q=Promise.resolve();

// ---------- sign-in ----------
function showSignIn(m){ document.getElementById('setupMsg').innerText=m||''; document.getElementById('setup').style.display='block'; }
function hideSignIn(){ document.getElementById('setup').style.display='none'; }
function initAuth(){
  if(tokenClient) return true;
  if(!(window.google&&google.accounts&&google.accounts.oauth2)) return false;
  tokenClient=google.accounts.oauth2.initTokenClient({client_id:CLIENT_ID,scope:SCOPE,callback:()=>{}});
  return true;
}
function requestToken(prompt){
  if(!initAuth()){ showSignIn('Google sign-in could not load. Check your internet and try again.'); return; }
  tokenClient.callback=r=>{
    if(r.error){ showSignIn('Sign-in failed. Tap the button to try again.'); return; }
    tok=r.access_token; tokExp=Date.now()+(r.expires_in||3600)*1000;
    localStorage.setItem('mt_signed','1'); hideSignIn();
    const f=pendingAuth; pendingAuth=[]; f.forEach(x=>x(tok));
  };
  tokenClient.error_callback=()=>showSignIn('Tap the button to continue.');
  tokenClient.requestAccessToken({prompt:prompt});
}
function signIn(){ requestToken(localStorage.getItem('mt_signed')?'':'consent'); }
function getToken(){
  if(tok&&Date.now()<tokExp-60000) return Promise.resolve(tok);
  return new Promise((res,rej)=>{
    if(!navigator.onLine){ rej(new Error('offline')); return; }
    pendingAuth.push(res);
    if(pendingAuth.length===1){
      if(/PASTE-YOUR/.test(CLIENT_ID)){ showSignIn('App not set up: add your Google Client ID in config.js'); return; }
      const was=localStorage.getItem('mt_signed');
      showSignIn(was?'Tap to continue.':'');
      if(was) requestToken('');
    }
  });
}
function signOut(){
  if(!confirm('Sign out of Google on this device? Entries still waiting to sync will be discarded.')) return;
  try{ if(tok&&window.google) google.accounts.oauth2.revoke(tok,()=>{}); }catch(e){}
  ['mt_signed','mt_sheet_id','mt_pending_entries'].forEach(k=>localStorage.removeItem(k));
  location.reload();
}
async function gfetch(url,opt,n){
  const t=await getToken();
  opt=opt||{}; opt.headers=Object.assign({Authorization:'Bearer '+t},opt.headers||{});
  const r=await fetch(url,opt);
  if(r.status===401&&!(n>0)){ tok=null; return gfetch(url,opt,1); }
  if(!r.ok) throw new Error('Google '+r.status+': '+(await r.text()).slice(0,200));
  return r.json();
}
const JH={'Content-Type':'application/json'};
async function vput(range,values){ dirty=true; return gfetch(SH+'/'+SID+'/values/'+encodeURIComponent(range)+'?valueInputOption=RAW',{method:'PUT',headers:JH,body:JSON.stringify({values:values})}); }
async function batch(requests){ dirty=true; return gfetch(SH+'/'+SID+':batchUpdate',{method:'POST',headers:JH,body:JSON.stringify({requests:requests})}); }
const rowDelReq=(name,row)=>({deleteDimension:{range:{sheetId:SID_OF[name],dimension:'ROWS',startIndex:row-1,endIndex:row}}});

// ---------- find or create the spreadsheet ----------
async function ensureSheet(){
  if(SID) return SID;
  const qs=encodeURIComponent("name='"+SHEET_TITLE+"' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
  const f=await gfetch('https://www.googleapis.com/drive/v3/files?q='+qs+'&fields=files(id)&orderBy=createdTime');
  if(f.files&&f.files.length) SID=f.files[0].id; else SID=await createSheet();
  localStorage.setItem('mt_sheet_id',SID);
  return SID;
}
async function createSheet(){
  const sheets=Object.keys(SID_OF).map(n=>({properties:{title:n,sheetId:SID_OF[n],gridProperties:n==='ENTRIES'?{rowCount:20000,columnCount:7,frozenRowCount:1}:{rowCount:1000,columnCount:6}}}));
  const c=await gfetch(SH,{method:'POST',headers:JH,body:JSON.stringify({properties:{title:SHEET_TITLE},sheets:sheets})});
  const id=c.spreadsheetId;
  const acc=['CASH','BANK'], cats=['FOOD','TRAVEL','MEDICAL','BILLS','SHOPPING','OTHER'];
  const data=[
    {range:"'MONEY TRACKER'!C1:D1",values:[['ACCOUNTS (FROM/TO)','CATEGORIES (FOR)']]},
    {range:"'MONEY TRACKER'!C2:C"+(acc.length+1),values:acc.map(x=>[x])},
    {range:"'MONEY TRACKER'!D2:D"+(cats.length+1),values:cats.map(x=>[x])},
    {range:'ENTRIES!A1',values:[['={"SR NO";ARRAYFORMULA(IF(B2:B="","",ROW(B2:B)-1))}']]},
    {range:'ENTRIES!B1:G1',values:[['DATE','AMOUNT','ACCOUNT','FOR','NOTES','TYPE']]},
    {range:'BUDGETS!A1:B1',values:[['CATEGORY','LIMIT']]},
    {range:"'OPENING BALANCE'!A1:B1",values:[['ACCOUNT','OPENING BALANCE']]},
    {range:'AUTOPAY!A1:F1',values:[['ACCOUNT','LABEL','DUE DAY','AMOUNT','PAID MONTH','START MONTH']]}
  ];
  await gfetch(SH+'/'+id+'/values:batchUpdate',{method:'POST',headers:JH,body:JSON.stringify({valueInputOption:'USER_ENTERED',data:data})});
  await gfetch(SH+'/'+id+':batchUpdate',{method:'POST',headers:JH,body:JSON.stringify({requests:[{repeatCell:{range:{sheetId:2,startRowIndex:1,startColumnIndex:1,endColumnIndex:2},cell:{userEnteredFormat:{numberFormat:{type:'DATE',pattern:'dd-mm-yyyy'}}},fields:'userEnteredFormat.numberFormat'}}]})});
  return id;
}

// ---------- read everything once, work on the copy ----------
const iso=x=>{
  if(typeof x==='number') return new Date(Date.UTC(1899,11,30)+Math.round(x)*86400000).toISOString().slice(0,10);
  const s=String(x), m=s.match(/^(\d{4}-\d{2}-\d{2})/); if(m) return m[1];
  const p=s.match(/^(\d{2})-(\d{2})-(\d{4})/); return p?p[3]+'-'+p[2]+'-'+p[1]:s;
};
const dmy=i=>i.slice(8,10)+'-'+i.slice(5,7)+'-'+i.slice(0,4);
const serial=i=>Math.round((Date.UTC(+i.slice(0,4),+i.slice(5,7)-1,+i.slice(8,10))-Date.UTC(1899,11,30))/86400000);
const S=x=>x==null?'':String(x);
const RANGES=["'MONEY TRACKER'!C2:D","ENTRIES!A2:G","BUDGETS!A2:B","'OPENING BALANCE'!A2:B","AUTOPAY!A2:F"];
async function load(force){
  if(DATA&&!dirty&&!force&&Date.now()-DATA_T<10000) return DATA;
  await ensureSheet();
  const j=await gfetch(SH+'/'+SID+'/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&'+RANGES.map(r=>'ranges='+encodeURIComponent(r)).join('&'));
  const v=j.valueRanges.map(x=>x.values||[]);
  const d={from:[],for:[],entries:[],lastRow:1,budgets:{},bRow:{},bLast:1,opening:{},oRow:{},oLast:1,autopays:[],apLast:1};
  v[0].forEach(r=>{ if(S(r[0]).trim()) d.from.push(S(r[0])); if(S(r[1]).trim()) d.for.push(S(r[1])); });
  v[1].forEach((r,i)=>{
    if(r[1]===undefined||r[1]==='') return;
    d.entries.push({row:i+2,sr:r[0],date:iso(r[1]),amount:Number(r[2])||0,from:S(r[3]),for:S(r[4]),notes:S(r[5]),type:S(r[6])});
    d.lastRow=i+2;
  });
  v[2].forEach((r,i)=>{ if(r[0]===undefined||r[0]==='') return; d.budgets[r[0]]=Number(r[1])||0; d.bRow[r[0]]=i+2; d.bLast=i+2; });
  v[3].forEach((r,i)=>{ if(r[0]===undefined||r[0]==='') return; d.opening[r[0]]=Number(r[1])||0; d.oRow[r[0]]=i+2; d.oLast=i+2; });
  v[4].forEach((r,i)=>{ if(r[0]===undefined||r[0]==='') return; d.autopays.push({row:i+2,account:S(r[0]),label:S(r[1]),day:Number(r[2]),amount:Number(r[3]),start:r[5]}); d.apLast=i+2; });
  DATA=d; DATA_T=Date.now(); dirty=false; return d;
}
const outE=e=>({row:e.row,sr:e.sr,date:dmy(e.date),amount:e.amount,from:e.from,for:e.for,notes:e.notes,type:e.type});

// ---------- logic ----------
function computeBalances(D){
  const b={}; D.from.forEach(a=>b[a]=D.opening[a]||0);
  D.entries.forEach(e=>{
    if(e.type==='EXPENSE'){ if(b[e.from]!==undefined) b[e.from]-=e.amount; }
    else if(e.type==='INCOME'){ if(b[e.from]!==undefined) b[e.from]+=e.amount; }
    else if(e.type==='TRANSFER'){
      if(b[e.from]!==undefined) b[e.from]-=e.amount;
      const to=e.for.startsWith('TO: ')?e.for.slice(4):'';
      if(b[to]!==undefined) b[to]+=e.amount;
    }
  });
  return b;
}
function depositTotal(D,month,acc){
  let t=0;
  D.entries.forEach(e=>{
    if(e.date.slice(0,7)!==month) return;
    if(e.type==='INCOME'&&e.from===acc) t+=e.amount;
    if(e.type==='TRANSFER'&&(e.for.startsWith('TO: ')?e.for.slice(4):'')===acc) t+=e.amount;
  });
  return t;
}
async function hdfcWarn(dest,month){
  if(dest!==HDFC_ACCOUNT) return '';
  const t=depositTotal(await load(true),month,HDFC_ACCOUNT);
  if(t>HDFC_LIMIT) return ' ⚠ HDFC deposits (income+transfer) this month: ₹'+t+' exceeds limit ₹'+HDFC_LIMIT;
  if(t>=HDFC_LIMIT*0.8) return ' ⚠ Approaching HDFC limit: ₹'+t+' / ₹'+HDFC_LIMIT;
  return '';
}
function entryRow(d){
  let acc,f,dest=null;
  if(d.type==='INCOME'){ acc=d.account; f='SOURCE: '+d.for; dest=d.account; }
  else if(d.type==='TRANSFER'){ acc=d.from; f='TO: '+d.to; dest=d.to; }
  else { acc=d.account; f=d.for; }
  return {vals:[serial(d.date),Number(d.amount),acc,f,d.notes||'',d.type],dest:dest};
}
async function setList(col,arr,prev){
  const n=Math.max(prev,arr.length); if(!n) return;
  const rows=[]; for(let i=0;i<n;i++) rows.push([i<arr.length?arr[i]:'']);
  await vput("'MONEY TRACKER'!"+col+'2:'+col+(n+1),rows);
}
async function listAdd(col,key,name){
  name=S(name).trim(); if(!name) return 'Enter a name';
  const D=await load(true), arr=D[key].slice();
  if(arr.some(v=>v.toUpperCase()===name.toUpperCase())) return 'Already exists';
  arr.push(name); await setList(col,arr,D[key].length); return 'Added';
}
async function listRemove(col,key,name){
  const D=await load(true); await setList(col,D[key].filter(v=>v!==name),D[key].length); return 'Removed';
}
const pad2=n=>String(n).padStart(2,'0');
const todayYMD=()=>{ const t=new Date(); return t.getFullYear()+'-'+pad2(t.getMonth()+1)+'-'+pad2(t.getDate()); };

const FN={
  async getLists(){ const D=await load(); return {fromList:D.from,forList:D.for}; },
  addAccount:n=>listAdd('C','from',n), removeAccount:n=>listRemove('C','from',n),
  addCategory:n=>listAdd('D','for',n), removeCategory:n=>listRemove('D','for',n),
  async getHDFCStatus(month){ const t=depositTotal(await load(),month,HDFC_ACCOUNT); return {total:t,limit:HDFC_LIMIT,remaining:Math.max(0,HDFC_LIMIT-t)}; },
  async saveEntry(d){
    const D=await load(true), r=entryRow(d), n=D.lastRow+1;
    await vput('ENTRIES!B'+n+':G'+n,[r.vals]);
    return 'Saved. SR NO '+D.lastRow+await hdfcWarn(r.dest,d.date.slice(0,7));
  },
  async updateEntryRow(row,d){
    await load(); const r=entryRow(d);
    await vput('ENTRIES!B'+row+':G'+row,[r.vals]);
    return 'Updated SR at row '+row+await hdfcWarn(r.dest,d.date.slice(0,7));
  },
  async deleteEntryRow(row){ await load(); await batch([rowDelReq('ENTRIES',row)]); return 'Deleted'; },
  async getEntriesForMonth(m){ const D=await load(); return D.entries.filter(e=>e.date.slice(0,7)===m).map(outE).sort((a,b)=>b.row-a.row); },
  async getEntriesForYear(y){ const D=await load(); return D.entries.filter(e=>e.date.slice(0,4)===String(y)).map(outE).sort((a,b)=>b.row-a.row); },
  async getEntryBySr(sr){ const D=await load(); const m=D.entries.filter(e=>S(e.sr)===S(sr)); return m.length?outE(m[m.length-1]):null; },
  async saveBudget(cat,limit){
    const D=await load(true), row=D.bRow[cat]||D.bLast+1;
    await vput('BUDGETS!A'+row+':B'+row,[[cat,limit]]); return 'Saved budget for '+cat;
  },
  async getOpeningBalances(){ const D=await load(); return D.from.map(a=>({account:a,amount:D.opening[a]||0})); },
  async saveOpeningBalance(acc,amt){
    const D=await load(true), row=D.oRow[acc]||D.oLast+1;
    await vput("'OPENING BALANCE'!A"+row+':B'+row,[[acc,amt]]); return 'Saved opening balance for '+acc;
  },
  async getBalancesOnly(){ return computeBalances(await load()); },
  async getSummary(month){
    const D=await load(), balances=computeBalances(D), cat={};
    let ex=0,inc=0,tr=0;
    D.entries.forEach(e=>{
      if(e.date.slice(0,7)!==month) return;
      if(e.type==='EXPENSE'){ ex+=e.amount; cat[e.for]=(cat[e.for]||0)+e.amount; }
      else if(e.type==='INCOME') inc+=e.amount; else if(e.type==='TRANSFER') tr+=e.amount;
    });
    Object.keys(D.budgets).forEach(c=>{ if(!(c in cat)) cat[c]=0; });
    const categories=Object.keys(cat).map(k=>({name:k,total:cat[k],limit:D.budgets[k]||0})).sort((a,b)=>b.total-a.total);
    const totalBudgeted=Object.values(D.budgets).reduce((s,v)=>s+v,0);
    return {balances,expenseTotal:ex,incomeTotal:inc,transferTotal:tr,categories,totalBudgeted};
  },
  async getAutopays(){ const D=await load(); return D.autopays.map(a=>({row:a.row,account:a.account,label:a.label,day:a.day,amount:a.amount})); },
  async saveAutopay(acc,label,day,amount,start){
    const D=await load(true), n=D.apLast+1;
    await vput('AUTOPAY!A'+n+':F'+n,[[acc,label,day,amount,'',start]]); return 'Auto-pay added';
  },
  async updateAutopay(row,acc,label,day,amount,start){
    await load(); await vput('AUTOPAY!A'+row+':F'+row,[[acc,label,day,amount,'',start]]); return 'Auto-pay updated';
  },
  async deleteAutopay(row){ await load(); await batch([rowDelReq('AUTOPAY',row)]); return 'Deleted'; },
  async processAutopays(){
    const D=await load(true), today=todayYMD(), cur=today.slice(0,7);
    const items=D.autopays.map(a=>{
      let sm=a.start; sm=typeof sm==='number'?iso(sm).slice(0,7):S(sm).trim().slice(0,7); if(!/^\d{4}-\d{2}$/.test(sm)) sm=cur;
      const y=+sm.slice(0,4), m=+sm.slice(5,7), dd=Math.min(a.day,new Date(y,m,0).getDate()), due=sm+'-'+pad2(dd);
      return Object.assign({},a,{startMonth:sm,dueDateISO:due,dueDateDisplay:pad2(dd)+'-'+pad2(m)+'-'+y});
    }).sort((a,b)=>a.dueDateISO.localeCompare(b.dueDateISO));
    const bal=computeBalances(D), existing={};
    D.entries.forEach(e=>{ if(e.notes!==AUTO_NOTE) return; const k=[e.date,e.amount,e.from,e.for].join('|'); existing[k]=(existing[k]||0)+1; });
    const results=[], news=[], del=[];
    items.forEach(it=>{
      const base={row:it.row,account:it.account,label:it.label,day:it.day,amount:it.amount,startMonth:it.startMonth,dueDateISO:it.dueDateISO,dueDateDisplay:it.dueDateDisplay};
      if(today<it.dueDateISO){ results.push(Object.assign({},base,{status:'UPCOMING'})); return; }
      const k=[it.dueDateISO,it.amount,it.account,it.label].join('|');
      if(existing[k]>0){ existing[k]--; del.push(it.row); return; }
      const b=bal[it.account]||0;
      if(b>=it.amount){ news.push([serial(it.dueDateISO),it.amount,it.account,it.label,AUTO_NOTE,'EXPENSE']); bal[it.account]=b-it.amount; del.push(it.row); }
      else results.push(Object.assign({},base,{status:'UNPAID'}));
    });
    if(news.length) await vput('ENTRIES!B'+(D.lastRow+1)+':G'+(D.lastRow+news.length),news);
    if(del.length) await batch(del.sort((a,b)=>b-a).map(r=>rowDelReq('AUTOPAY',r)));
    return results.sort((a,b)=>a.dueDateISO.localeCompare(b.dueDateISO));
  },
  async getAutopaySummary(month){
    const D=await load(), bal=computeBalances(D), by={};
    D.autopays.forEach(a=>by[a.account]=(by[a.account]||0)+a.amount);
    const accounts=Object.keys(by).map(acc=>{ const sc=by[acc], b=bal[acc]||0, def=sc-b; return {account:acc,scheduled:sc,balance:b,deficit:def>0?def:0}; });
    const t=depositTotal(D,month,HDFC_ACCOUNT);
    return {autopays:D.autopays,accounts:accounts,hdfc:{total:t,limit:HDFC_LIMIT,remaining:Math.max(0,HDFC_LIMIT-t)}};
  }
};

// ---------- same call style the screens already use ----------
function callApi(fn,args){ const p=q.then(()=>FN[fn].apply(null,args)); q=p.catch(()=>{}); return p; }
function makeRunner(ok,fail){
  return new Proxy({},{get:function(_,name){
    if(name==='withSuccessHandler') return f=>makeRunner(f,fail);
    if(name==='withFailureHandler') return f=>makeRunner(ok,f);
    return (...args)=>{ callApi(name,args).then(r=>{ if(ok) ok(r); },e=>{ if(fail) fail(e); else console.error(name,e); }); };
  }});
}
const GS={run:makeRunner(null,null),url:{getLocation:cb=>cb({parameter:Object.fromEntries(new URLSearchParams(location.search))})}};
