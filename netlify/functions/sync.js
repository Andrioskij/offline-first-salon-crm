// Salon CRM — funzione di sincronizzazione (Google Drive) con protezioni di resilienza.
// Variabili d'ambiente richieste su Netlify:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, APP_PASSWORD

const FILE_NAME  = 'saloncrm-dati.json';
const BAK_PREFIX = 'saloncrm-bak-';
const KEEP_BAKS  = 10;
let cachedToken = null;

// Ottiene da Google un permesso temporaneo partendo dal token permanente. Lo tiene in cache finche' e' valido.
async function getAccessToken(){
  if(cachedToken && Date.now() < cachedToken.exp - 60000) return cachedToken.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:'refresh_token'
    })
  });
  if(!res.ok) throw new Error('token '+res.status);
  const data = await res.json();
  cachedToken = {token:data.access_token, exp:Date.now() + (data.expires_in||3600)*1000};
  return cachedToken.token;
}

// Aggiunge l'intestazione di autorizzazione a una chiamata verso Drive.
function auth(token, opts){
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers, {Authorization:'Bearer '+token});
  return opts;
}

// Cerca su Drive il file per nome e ne restituisce l'identificativo.
async function findFileId(token, name){
  const q = encodeURIComponent("name='"+name+"' and trashed=false");
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q='+q+'&fields=files(id)&spaces=drive', auth(token));
  if(!res.ok) throw new Error('list '+res.status);
  const data = await res.json();
  return (data.files && data.files[0] && data.files[0].id) || null;
}

// Elenca le copie di riserva presenti su Drive.
async function listBackups(token){
  const q = encodeURIComponent("name contains '"+BAK_PREFIX+"' and trashed=false");
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q='+q+'&fields=files(id,name)&spaces=drive&orderBy=name', auth(token));
  if(!res.ok) return [];
  const data = await res.json();
  return data.files || [];
}

// Scarica e interpreta il contenuto di un file su Drive.
async function readFile(token, fileId){
  const res = await fetch('https://www.googleapis.com/drive/v3/files/'+fileId+'?alt=media', auth(token));
  if(!res.ok) throw new Error('read '+res.status);
  return res.json();
}

// Crea un nuovo file su Drive con il contenuto indicato.
async function createFile(token, name, payload){
  const body = JSON.stringify(payload);
  const boundary = 'hs'+Math.random().toString(36).slice(2);
  const multipart =
    '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({name:name, mimeType:'application/json'}) +
    '\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+body+'\r\n--'+boundary+'--';
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    auth(token, {method:'POST', headers:{'Content-Type':'multipart/related; boundary='+boundary}, body:multipart}));
  if(!res.ok) throw new Error('create '+res.status);
  return (await res.json()).id;
}

// Sovrascrive un file esistente; se non esiste piu' restituisce null.
async function updateFile(token, fileId, payload){
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files/'+fileId+'?uploadType=media',
    auth(token, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}));
  if(res.status === 404) return null;
  if(!res.ok) throw new Error('update '+res.status);
  return fileId;
}

// Elimina un file da Drive (usato per sfoltire le copie vecchie).
async function deleteFile(token, fileId){
  await fetch('https://www.googleapis.com/drive/v3/files/'+fileId, auth(token, {method:'DELETE'}));
}

// Conta i record "vivi": metrica per la guardia anti-azzeramento
// Conta i record non cancellati: e' la misura su cui si basa la guardia anti-azzeramento.
function liveCount(d){
  if(!d) return 0;
  let n = 0;
  ['clients','visits','services','comments','posts','staff'].forEach(function(k){
    if(Array.isArray(d[k])) n += d[k].filter(function(x){ return x && !x.deleted; }).length;
  });
  return n;
}

// Punto d'ingresso. Ogni richiesta: verifica il codice di accesso, poi esegue l'azione
// richiesta (load / save / backups / restore) sul file di Drive.
exports.handler = async function(event){
  const H = {'Content-Type':'application/json'};
  if(event.httpMethod !== 'POST') return {statusCode:405, headers:H, body:'{"error":"method"}'};

  let req;
  try{ req = JSON.parse(event.body || '{}'); }
  catch(e){ return {statusCode:400, headers:H, body:'{"error":"bad json"}'}; }

  if(!process.env.APP_PASSWORD || req.password !== process.env.APP_PASSWORD){
    return {statusCode:401, headers:H, body:'{"error":"unauthorized"}'};
  }

  try{
    const token = await getAccessToken();
    const fileId = await findFileId(token, FILE_NAME);

    // LOAD: restituisce l'intero archivio (null se il file non esiste ancora)
    if(req.action === 'load'){
      if(!fileId) return {statusCode:200, headers:H, body:JSON.stringify({data:null})};
      const data = await readFile(token, fileId);
      return {statusCode:200, headers:H, body:JSON.stringify({data:data})};
    }

    // SAVE: guardia anti-azzeramento, copia di riserva, poi scrittura
    if(req.action === 'save'){
      if(!req.data || typeof req.data !== 'object' || !Array.isArray(req.data.clients)){
        return {statusCode:400, headers:H, body:'{"error":"bad data"}'};
      }

      const incoming = liveCount(req.data);

      if(!fileId){
        const id = await createFile(token, FILE_NAME, req.data);
        return {statusCode:200, headers:H, body:JSON.stringify({ok:true, created:true, id:id})};
      }

      let current = null;
      try{ current = await readFile(token, fileId); }catch(e){ current = null; }
      const existing = liveCount(current);

      // Guardia anti-azzeramento
      if(!req.force && existing >= 5 && incoming < existing * 0.5){
        return {statusCode:409, headers:H, body:JSON.stringify({
          error:'shrink_guard',
          message:'Il salvataggio ridurrebbe i dati da '+existing+' a '+incoming+' record. Bloccato per sicurezza.',
          existing:existing, incoming:incoming
        })};
      }

      // Copie di riserva a rotazione (best-effort)
      if(current){
        try{
          const stamp = new Date().toISOString().replace(/[:.]/g,'-');
          await createFile(token, BAK_PREFIX+stamp+'.json', current);
          const baks = await listBackups(token);
          if(baks.length > KEEP_BAKS){
            const sorted = baks.sort(function(a,b){ return a.name.localeCompare(b.name); });
            const toDelete = sorted.slice(0, sorted.length - KEEP_BAKS);
            for(let i=0;i<toDelete.length;i++){ await deleteFile(token, toDelete[i].id); }
          }
        }catch(e){}
      }

      const ok = await updateFile(token, fileId, req.data);
      if(ok === null){
        const id = await createFile(token, FILE_NAME, req.data);
        return {statusCode:200, headers:H, body:JSON.stringify({ok:true, recreated:true, id:id})};
      }
      return {statusCode:200, headers:H, body:JSON.stringify({ok:true, count:incoming, backedUp:!!current})};
    }

    // BACKUPS: elenco delle copie di riserva disponibili
    if(req.action === 'backups'){
      const baks = await listBackups(token);
      const out = baks.sort(function(a,b){ return b.name.localeCompare(a.name); }).map(function(b){
        const raw = b.name.replace(BAK_PREFIX,'').replace('.json','');
        return {id:b.id, at:raw.slice(0,10)+' '+raw.slice(11,16).replace('-',':'), count:null};
      });
      return {statusCode:200, headers:H, body:JSON.stringify({backups:out})};
    }

    // RESTORE: riporta il file principale al contenuto di una copia scelta
    if(req.action === 'restore'){
      if(!req.backupId) return {statusCode:400, headers:H, body:'{"error":"backupId mancante"}'};
      const data = await readFile(token, req.backupId);
      if(fileId) await updateFile(token, fileId, data);
      else await createFile(token, FILE_NAME, data);
      return {statusCode:200, headers:H, body:JSON.stringify({ok:true})};
    }

    return {statusCode:400, headers:H, body:'{"error":"unknown action"}'};
  }catch(e){
    return {statusCode:500, headers:H, body:JSON.stringify({error:String(e.message||e).slice(0,200)})};
  }
};
