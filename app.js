/* Earshot — catch words and thoughts from what you are listening to.
   No build step, no dependencies.

   The whole UI is rendered from state into #view, and every control is
   reached by event delegation on a `data-act` attribute. That is deliberate:
   a control that disappears from a template can no longer break the ones
   that come after it.

   Sections: storage → transcript index → entries → helpers → views
             → speech → actions → tools → boot                            */

(function(){
  "use strict";

  var VERSION = "3.4";
  var KEY = "earshot.v3", KEY_V2 = "earshot.v2", KEY_V1 = "earshot.v1";
  var SEED = {};                       // definitions Claude can seed on republish

  var $ = function(s, r){ return (r || document).querySelector(s); };

  var store = { v:3, episodes:[], entries:[], activeId:null };
  var indexes = {};                    // episodeId -> built transcript index

  var ui = {
    tab: "listen",
    ep: null,                          // open episode page
    epSeg: "notes",
    form: null,                        // null | "new" | episodeId
    panel: null,                       // null | "defs" | "batch" | "note"
    wordFilter: "all",
    noteFilter: "all",
    q: "",
    showDone: false,
    settings: false,
    notice: ""
  };

  /* ============================ storage ============================ */

  function newId(p){ return (p || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  function readStore(){
    var d = readJSON(KEY);
    if(d && d.episodes){
      return {
        v:3,
        episodes: (d.episodes || []).map(normEpisode),
        entries: (d.entries || []).filter(function(e){ return e && e.id; }),
        activeId: d.activeId || null
      };
    }
    var v2 = readJSON(KEY_V2);
    if(v2 && (v2.episodes || v2.entries)){
      return {
        v:3,
        episodes: (v2.episodes || []).map(normEpisode),
        entries: (v2.entries || []).filter(function(e){ return e && e.id; }),
        activeId: v2.activeId || null
      };
    }
    return migrateV1();
  }

  function readJSON(k){
    try{ var raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; }
    catch(e){ return null; }
  }

  function normEpisode(ep){
    ep.status = ep.status || "queued";
    ep.title = ep.title || "Untitled";
    ep.url = ep.url || "";
    ep.transcript = ep.transcript || "";
    ep.createdAt = ep.createdAt || Date.now();
    ep.updatedAt = ep.updatedAt || ep.createdAt;
    return ep;
  }

  function migrateV1(){
    var d = readJSON(KEY_V1);
    var old = d ? (Array.isArray(d) ? d : (d.entries || [])) : [];
    if(!old.length) return { v:3, episodes:[], entries:[], activeId:null };
    var ep = normEpisode({ id:"ep-earlier", title:"Earlier words", createdAt:Date.now() });
    old.forEach(function(e){ e.episodeId = ep.id; e.kind = e.kind || "word"; });
    return { v:3, episodes:[ep], entries:old, activeId:null };
  }

  function save(){
    forgetSightings();
    try{ localStorage.setItem(KEY, JSON.stringify(store)); }catch(e){}
  }

  function mergeEntries(a, b){
    var map = {};
    (a || []).concat(b || []).forEach(function(e){
      if(!e || !e.id) return;
      var prev = map[e.id];
      if(!prev || (e.updatedAt || 0) >= (prev.updatedAt || 0)) map[e.id] = e;
    });
    return Object.keys(map).map(function(k){ return map[k]; })
      .sort(function(x,y){ return (y.createdAt||0) - (x.createdAt||0); });
  }

  function episodeById(id){ return store.episodes.filter(function(e){ return e.id === id; })[0] || null; }
  function activeEpisode(){ return episodeById(store.activeId); }
  function entriesOf(id){ return store.entries.filter(function(e){ return e.episodeId === id; }); }

  /* ======================= transcript index ======================= */

  var TIME_LEAD = /^\s*[\[\(]?(\d{1,2}:\d{2}(?::\d{2})?)[\]\)]?\s*/;
  var SPEAKER = /^\s*[A-Z][\w .'’-]{0,28}:\s+/;
  var VTT_CUE = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/;

  function parseTime(s){
    var p = String(s).split(":").map(Number);
    if(p.some(isNaN)) return null;
    if(p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
    if(p.length === 2) return p[0]*60 + p[1];
    return null;
  }

  function fmtDuration(sec){
    if(!sec) return "";
    var m = Math.round(sec / 60);
    if(m < 60) return Math.max(1, m) + " min";
    return Math.floor(m / 60) + " h " + ("0" + (m % 60)).slice(-2);
  }

  function fmtTime(sec){
    if(sec === null || sec === undefined) return "";
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    return (h ? h + ":" : "") + (h && m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* Raw WebVTT — YouTube repeats the previous line in each cue and wraps
     words in timing tags; both go. */
  function parseVTT(raw){
    var out = [], t = null;
    String(raw).replace(/\r/g,"").split("\n").forEach(function(line){
      line = line.trim();
      if(!line || line === "WEBVTT") return;
      if(/^(Kind|Language|NOTE|STYLE|REGION)\b/.test(line)) return;
      var m = line.match(VTT_CUE);
      if(m){ t = (+m[1])*3600 + (+m[2])*60 + (+m[3]) + (+m[4])/1000; return; }
      if(/^\d+$/.test(line)) return;
      if(t === null) return;
      var text = line.replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ")
        .replace(/&amp;/g,"&").replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"')
        .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim();
      if(!text) return;
      if(out.length && out[out.length-1].text === text) return;
      out.push({ text:text, t:Math.round(t) });
    });
    return out;
  }

  function buildIndex(raw){
    var src = String(raw || "");
    if(/^\s*WEBVTT/.test(src) || VTT_CUE.test(src)){
      var cues = parseVTT(src);
      if(cues.length) return finishIndex(groupChunks(cues));
    }

    var chunks = [], lastT = null;
    src.replace(/\r/g,"").split("\n").forEach(function(line){
      var t = null, m = line.match(TIME_LEAD);
      if(m){ t = parseTime(m[1]); line = line.slice(m[0].length); }
      if(t !== null) lastT = t;            // YouTube puts the stamp on its own line
      line = line.replace(/[\[\(]\d{1,2}:\d{2}(?::\d{2})?[\]\)]/g," ")
                 .replace(SPEAKER," ").replace(/\s+/g," ").trim();
      if(!line) return;
      chunks.push({ text:line, t:lastT });
    });

    var punct = chunks.filter(function(c){ return /[.!?]/.test(c.text); }).length;
    if(chunks.length >= 2 && punct < chunks.length * 0.15) return finishIndex(groupChunks(chunks));

    var sentences = [], buf = "", bufT = null;
    chunks.forEach(function(c){
      if(!buf) bufT = c.t;
      buf = (buf ? buf + " " : "") + c.text;
      var parts = buf.match(/[^.!?]+[.!?]+/g);
      if(parts){
        parts.forEach(function(p){
          var s = p.trim();
          if(s.length > 1) sentences.push({ text:s, t:bufT });
        });
        buf = buf.slice(parts.join("").length).trim();
        bufT = c.t;
      }
    });
    if(buf.trim().length > 1) sentences.push({ text:buf.trim(), t:bufT });

    var tooLong = sentences.filter(function(s){ return s.text.length > 600; }).length;
    if(sentences.length && tooLong / sentences.length > 0.5) return finishIndex(groupChunks(chunks));
    return finishIndex(sentences);
  }

  function groupChunks(chunks){
    var out = [], buf = [], bufT = null, words = 0;
    chunks.forEach(function(c){
      if(!buf.length) bufT = c.t;
      buf.push(c.text);
      words += c.text.split(/\s+/).length;
      if(words >= 20){ out.push({ text:buf.join(" ").trim(), t:bufT }); buf = []; words = 0; bufT = null; }
    });
    if(buf.length) out.push({ text:buf.join(" ").trim(), t:bufT });
    return out;
  }

  function finishIndex(sentences){
    var vocab = {};
    (sentences.map(function(s){ return s.text; }).join(" ").toLowerCase()
      .match(/[a-z][a-z'’-]{2,}/g) || []).forEach(function(w){ vocab[w] = (vocab[w]||0) + 1; });
    var stamped = sentences.filter(function(s){ return s.t !== null && s.t !== undefined; });
    return {
      sentences: sentences,
      vocab: vocab,
      words: Object.keys(vocab).length,
      timestamps: stamped.length,
      duration: stamped.length ? stamped[stamped.length-1].t : null
    };
  }

  function indexFor(ep){
    if(!ep || !ep.transcript) return null;
    if(!indexes[ep.id]) indexes[ep.id] = buildIndex(ep.transcript);
    return indexes[ep.id];
  }

  function editDistance(a, b, max){
    if(Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for(j = 0; j <= b.length; j++) prev[j] = j;
    for(i = 1; i <= a.length; i++){
      cur[0] = i;
      var best = i;
      for(j = 1; j <= b.length; j++){
        cur[j] = Math.min(prev[j]+1, cur[j-1]+1, prev[j-1] + (a.charAt(i-1) === b.charAt(j-1) ? 0 : 1));
        if(cur[j] < best) best = cur[j];
      }
      if(best > max) return max + 1;
      prev = cur.slice();
    }
    return prev[b.length];
  }

  function nearestInVocab(vocab, word){
    var best = null, bestD = 3, bestCount = 0;
    for(var t in vocab){
      if(Math.abs(t.length - word.length) > 2) continue;
      var d = editDistance(word, t, 2);
      if(d < bestD || (d === bestD && vocab[t] > bestCount)){ bestD = d; best = t; bestCount = vocab[t]; }
    }
    return bestD <= 2 ? best : null;
  }

  function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function findInIndex(idx, word){
    var re = new RegExp("\\b" + escRe(word) + "(?:s|es|ed|d|ing)?\\b", "i");
    for(var i = 0; i < idx.sentences.length; i++) if(re.test(idx.sentences[i].text)) return idx.sentences[i];
    return null;
  }

  /* Where in the transcript is this snippet of overheard audio? */
  function locate(idx, snippet){
    var words = String(snippet||"").toLowerCase().match(/[a-z][a-z'’-]{3,}/g) || [];
    if(words.length < 4) return null;
    var want = {};
    words.forEach(function(w){ want[w] = 1; });
    var best = null, bestScore = 0;
    idx.sentences.forEach(function(s){
      var toks = s.text.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) || [];
      if(!toks.length) return;
      var hits = 0;
      toks.forEach(function(t){ if(want[t]) hits++; });
      var score = hits / Math.sqrt(toks.length);
      if(score > bestScore){ bestScore = score; best = s; }
    });
    return bestScore >= 1.2 ? best : null;
  }

  /* ---- re-encounters -------------------------------------------------
     Every transcript you paste is a sample of the English you actually
     consume, so a word you saved once can be spotted turning up again in
     something else you queued. One pass builds word -> [{episode, time}];
     the vocabulary map makes the first check O(1) so this stays cheap. */
  var sightings = null;

  function inVocab(idx, w){
    return !!(idx.vocab[w] || idx.vocab[w+"s"] || idx.vocab[w+"es"] ||
              idx.vocab[w+"ed"] || idx.vocab[w+"d"] || idx.vocab[w+"ing"]);
  }

  function buildSightings(){
    if(sightings) return sightings;
    sightings = {};
    var words = {};
    // a word you have marked known no longer needs surfacing
    store.entries.forEach(function(e){ if(e.kind !== "note" && e.word && !e.known) words[e.word] = 1; });
    var list = Object.keys(words);
    if(!list.length) return sightings;

    store.episodes.forEach(function(ep){
      var idx = indexFor(ep);
      if(!idx) return;
      list.forEach(function(w){
        if(!inVocab(idx, w)) return;
        var hit = findInIndex(idx, w);
        if(!hit) return;
        (sightings[w] = sightings[w] || []).push({ epId:ep.id, t:hit.t, sentence:clipAround(hit.text, w) });
      });
    });
    return sightings;
  }

  function forgetSightings(){ sightings = null; }

  /* other episodes where this saved word also appears */
  function alsoIn(entry){
    if(entry.kind === "note" || !entry.word) return [];
    if(entry.known) return [];
    return (buildSightings()[entry.word] || []).filter(function(x){
      return x.epId !== entry.episodeId && episodeById(x.epId);
    });
  }

  /* words saved elsewhere that turn up in this episode */
  function turnUpIn(ep){
    var s = buildSightings(), first = {}, out = [];
    store.entries.forEach(function(e){
      if(e.kind === "note" || e.episodeId === ep.id || e.known) return;
      if(!first[e.word]) first[e.word] = e;
    });
    Object.keys(first).forEach(function(w){
      (s[w] || []).forEach(function(x){
        if(x.epId === ep.id) out.push({ entry:first[w], t:x.t, sentence:x.sentence });
      });
    });
    return out.sort(function(a,b){ return (a.t||0) - (b.t||0); });
  }

  function clipAround(s, word){
    if(s.length <= 260) return s;
    var i = s.toLowerCase().indexOf(String(word).toLowerCase());
    if(i === -1) return s.slice(0,257).trim() + "…";
    var a = Math.max(0, i-110), b = Math.min(s.length, i+150);
    return (a > 0 ? "…" : "") + s.slice(a,b).trim() + (b < s.length ? "…" : "");
  }

  function resolveWord(word){
    var idx = indexFor(activeEpisode());
    if(!idx) return { word:word, sentence:"", t:null, matched:false };
    var hit = findInIndex(idx, word), used = word, repaired = false;
    if(!hit){
      var alt = nearestInVocab(idx.vocab, word);
      if(alt && alt !== word){
        hit = findInIndex(idx, alt);
        if(hit){ used = alt; repaired = true; }
      }
    }
    if(!hit) return { word:word, sentence:"", t:null, matched:false };
    return { word:used, sentence:clipAround(hit.text, used), t:hit.t, matched:true, repaired:repaired };
  }

  /* ============================ entries ============================ */

  function cleanWord(w){ return String(w||"").toLowerCase().replace(/[^a-z'’\- ]/g,"").trim(); }

  function pickDef(d){
    return {
      meaning: String(d.meaning || d.definition || "").trim(),
      example: String(d.example || "").trim(),
      ipa: String(d.ipa || d.pronunciation || "").trim(),
      pos: String(d.pos || d.partOfSpeech || "").trim()
    };
  }

  function applySeed(){
    store.entries.forEach(function(e){
      if(e.kind !== "note" && !e.meaning && SEED[e.word]){
        Object.assign(e, pickDef(SEED[e.word]));
        e.updatedAt = Date.now();
      }
    });
  }

  function addWord(word, spoken, source, epId){
    var w = cleanWord(word);
    if(w.length < 2) return null;
    var ep = epId || store.activeId;
    var now = Date.now();
    var dupe = store.entries.filter(function(e){
      return e.kind !== "note" && e.word === w && e.episodeId === ep;
    })[0];
    if(dupe && now - (dupe.createdAt||0) < 60000) return null;

    var res = (ep === store.activeId) ? resolveWord(w) : { word:w, sentence:"", t:null, matched:false };
    var entry = {
      id:newId("w"), kind:"word", episodeId:ep,
      word: res.matched ? res.word : w,
      heardAs: res.repaired ? w : "",
      sentence: res.matched ? res.sentence : String(spoken||"").trim(),
      t: res.t, via: res.matched ? "transcript" : "",
      source: source || "voice",
      createdAt:now, updatedAt:now,
      meaning:"", example:"", ipa:"", pos:""
    };
    if(SEED[entry.word]) Object.assign(entry, pickDef(SEED[entry.word]));
    store.entries.unshift(entry);
    save();
    return entry;
  }

  function addNote(text, source, epId){
    var body = String(text||"").trim();
    if(body.length < 2) return null;
    var ep = epId || store.activeId;
    var idx = indexFor(episodeById(ep));
    var passage = (idx && source === "voice") ? locate(idx, contextBefore(Date.now())) : null;
    var now = Date.now();
    var entry = {
      id:newId("n"), kind:"note", episodeId:ep,
      text:body, passage: passage ? passage.text : "", t: passage ? passage.t : null,
      source: source || "typed", createdAt:now, updatedAt:now
    };
    store.entries.unshift(entry);
    save();
    return entry;
  }

  /* ============================ helpers ============================ */

  function esc(s){
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  function when(ts){
    var d = new Date(ts || Date.now());
    var diff = (Date.now() - d.getTime()) / 86400000;
    if(diff < 1) return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
    if(diff < 7) return d.toLocaleDateString([], {weekday:"short"});
    return d.toLocaleDateString([], {day:"numeric", month:"short"});
  }

  function ytId(url){
    var m = String(url||"").match(/(?:youtube\.com\/watch\?[^#]*\bv=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
    return m ? m[1] : "";
  }

  function jumpLink(ep, t){
    if(!ep || !ep.url || t === null || t === undefined) return "";
    var sec = Math.max(0, Math.round(t)), id = ytId(ep.url);
    if(id) return "https://www.youtube.com/watch?v=" + id + "&t=" + sec + "s";
    if(/open\.spotify\.com/.test(ep.url)) return ep.url.split("?")[0] + "?t=" + sec;
    return ep.url + (ep.url.indexOf("#") === -1 ? "#t=" + sec : "");
  }

  function stampHTML(ep, t){
    if(t === null || t === undefined) return "";
    var link = jumpLink(ep, t);
    return link
      ? '<a class="stamp" href="' + esc(link) + '" target="_blank" rel="noopener">' + fmtTime(t) + "</a>"
      : '<span class="stamp flat">' + fmtTime(t) + "</span>";
  }

  function hue(s){
    var h = 0;
    for(var i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) % 360;
    return h;
  }

  function artHTML(ep, cls){
    var h = hue(ep.title || ep.id), id = ytId(ep.url);
    var bg = "background:linear-gradient(135deg,hsl(" + h + " 30% 74%),hsl(" + ((h+34)%360) + " 26% 58%))";
    return '<span class="art ' + (cls||"") + '" style="' + bg + '">' +
      (id ? '<img class="artimg" src="https://img.youtube.com/vi/' + esc(id) + '/mqdefault.jpg" alt="" loading="lazy">' : "") +
      "</span>";
  }

  function epMetaHTML(ep){
    var idx = indexFor(ep), bits = [];
    if(idx && idx.duration) bits.push("<span>" + fmtDuration(idx.duration) + "</span>");
    bits.push(idx
      ? '<span class="ok">transcript</span>'
      : '<button class="linky" data-act="edit-ep" data-id="' + esc(ep.id) + '">+ transcript</button>');
    var mine = entriesOf(ep.id);
    var words = mine.filter(function(e){ return e.kind !== "note"; }).length;
    var notes = mine.length - words;
    if(words) bits.push('<span class="strong">' + words + (words === 1 ? " word" : " words") + "</span>");
    if(notes) bits.push("<span>" + notes + (notes === 1 ? " note" : " notes") + "</span>");
    var again = idx ? turnUpIn(ep).length : 0;
    if(again) bits.push('<span class="again">' + again + " of yours</span>");
    return bits.join('<span class="sep">·</span>');
  }

  /* ============================ views ============================ */

  function icon(name, c){
    var s = 'stroke="' + c + '" stroke-width="1.6" stroke-linecap="round"';
    if(name === "listen") return '<circle cx="6" cy="10" r="1.8" fill="' + c + '"/>' +
      '<path d="M10 6.5 A5 5 0 0 1 10 13.5" ' + s + '/><path d="M13 4 A8.5 8.5 0 0 1 13 16" ' + s + '/>';
    if(name === "notes") return '<rect x="4" y="3" width="12" height="14" rx="2" ' + s + ' fill="none"/>' +
      '<path d="M7 7.5 H13 M7 10.5 H13 M7 13.5 H10.5" stroke="' + c + '" stroke-width="1.4" stroke-linecap="round"/>';
    return '<path d="M4 5 H16 M4 10 H16 M4 15 H11" ' + s + '/>';
  }

  function renderTabs(){
    var bar = $("#tabbar");
    var tabs = [["listen","Listen"],["notes","Notes"],["words","Words"]];
    bar.innerHTML = tabs.map(function(t){
      var on = ui.tab === t[0] && !ui.settings;
      var live = t[0] === "listen" && wantListening;
      var label = live ? "Listening" : t[1];
      var color = on ? (live ? "var(--live)" : "var(--ink)") : "var(--muted)";
      return '<button class="tab' + (live ? " live" : "") + '" data-act="tab" data-tab="' + t[0] + '"' +
        (on ? ' aria-current="page"' : "") + '>' +
        '<svg width="20" height="20" viewBox="0 0 20 20" fill="none">' + icon(t[0], color) + "</svg>" +
        "<span>" + label + "</span></button>";
    }).join("");
  }

  function noticeHTML(){
    if(!ui.notice) return "";
    return '<div class="notice' + (ui.noticeWarn ? " warn" : "") + '">' + ui.notice + "</div>";
  }

  function mastheadHTML(title, eyebrow, right){
    return '<div class="masthead"><div class="brand"><h1>' + esc(title) + "</h1>" +
      (eyebrow ? '<span class="eyebrow">' + eyebrow + "</span>" : "") + "</div>" +
      (right || "") + "</div>";
  }

  /* ---- Listen ---- */

  function viewListen(){
    var live = activeEpisode();
    var queued = store.episodes.filter(function(e){ return e.status !== "done" && e.id !== (live && wantListening ? live.id : null); });
    var done = store.episodes.filter(function(e){ return e.status === "done"; });
    var words = store.entries.filter(function(e){ return e.kind !== "note"; });

    var html = mastheadHTML("Earshot", "catch · review",
      '<div class="counts"><div><b>' + words.filter(function(e){ return e.known; }).length + "</b> yours</div>" +
      '<div><b>' + words.filter(function(e){ return !e.meaning; }).length + "</b> to explain</div></div>");

    if(live && wantListening) html += nowPlayingHTML(live);
    html += noticeHTML();

    if(!store.episodes.length){
      html += '<div class="empty"><strong>Nothing queued yet</strong>' +
        "Add the episode you&rsquo;re about to listen to, with its transcript. Then every word you catch " +
        "comes back spelled right, in the sentence you heard it in.</div>" +
        '<div class="row" style="margin-top:12px"><button class="primary" data-act="new-ep">Add an episode</button></div>';
      return html + formHTML();
    }

    html += '<div class="seclabel">' + (live && wantListening ? "up next" : "your queue") + "</div>";
    html += '<div class="queue">' + queued.map(epRowHTML).join("") + "</div>";
    html += '<button class="addrow" data-act="new-ep">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3 V13 M3 8 H13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
      "Add an episode</button>";
    html += formHTML();

    if(done.length){
      html += '<button class="collapse" data-act="toggle-done">' +
        '<span class="seclabel">finished</span>' +
        '<span class="seclabel" style="opacity:.7">' + done.length + "</span>" +
        '<span style="flex:1"></span>' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="transform:rotate(' + (ui.showDone ? 180 : 0) + 'deg)">' +
        '<path d="M4 6.5 L8 10.5 L12 6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
      if(ui.showDone) html += '<div class="queue">' + done.map(epRowHTML).join("") + "</div>";
    }
    return html;
  }

  function epRowHTML(ep){
    var isLive = wantListening && ep.id === store.activeId;
    var idx = indexFor(ep);
    var cls = "eprow" + (isLive ? " live" : "") + (ep.status === "done" ? " done" : "");
    /* Play is always available. A missing transcript costs you spelling repair
       and timestamps, not the ability to listen — plenty of podcasts have no
       transcript at all, and you can always add one afterwards and re-match. */
    var right = isLive
      ? '<button class="play stop" data-act="stop" aria-label="Stop listening">' +
        '<svg width="14" height="14" viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="var(--live)"/></svg></button>'
      : '<button class="play' + (idx ? "" : " bare") + '" data-act="play" data-id="' + esc(ep.id) +
        '" aria-label="Listen to ' + esc(ep.title) + '">' +
        '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4.5 2.8 L13 8 L4.5 13.2 Z" fill="currentColor"/></svg></button>';
    return '<div class="' + cls + '">' +
      '<button class="epopen" data-act="open-ep" data-id="' + esc(ep.id) + '">' +
        artHTML(ep) +
        '<span class="eptext"><span class="eptitle">' + esc(ep.title) + "</span>" +
        '<span class="epmeta">' + (isLive ? '<span class="bad strong">listening</span><span class="sep">·</span>' : "") + epMetaHTML(ep) + "</span></span>" +
      "</button>" + right + "</div>";
  }

  function nowPlayingHTML(ep){
    var recent = entriesOf(ep.id).slice(0, 2);
    return '<div class="now">' +
      '<button class="epopen nowhead" data-act="open-ep" data-id="' + esc(ep.id) + '">' + artHTML(ep) +
        '<span class="eptext"><span class="cue" style="color:var(--live)">listening to</span>' +
        '<span class="eptitle">' + esc(ep.title) + "</span>" +
        '<span class="epmeta">' + epMetaHTML(ep) + "</span></span></button>" +
      micHTML() +
      '<div class="ribbon"><span class="cue">heard</span><span class="txt" id="ribbon"><bdi>Nothing yet.</bdi></span></div>' +
      (recent.length ? '<div class="list" style="margin-top:2px">' + recent.map(function(e){ return cardHTML(e, ep); }).join("") + "</div>" : "") +
      "</div>";
  }

  function micHTML(){
    var on = wantListening;
    return '<button class="mic" data-act="mic" aria-pressed="' + (on ? "true" : "false") + '">' +
      '<span class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' +
      '<span class="lab"><strong>' + (on ? "Listening" : "Start listening") + "</strong>" +
      "<span>&ldquo;save&rdquo; + a word &middot; &ldquo;note that&rdquo; + a thought</span></span></button>";
  }

  /* ---- episode page ---- */

  function viewEpisode(){
    var ep = episodeById(ui.ep);
    if(!ep){ ui.ep = null; return viewListen(); }
    var idx = indexFor(ep);
    var mine = entriesOf(ep.id);
    var notes = mine.filter(function(e){ return e.kind === "note"; });
    var words = mine.filter(function(e){ return e.kind !== "note"; });
    var isLive = wantListening && ep.id === store.activeId;

    var html = '<div class="nav"><button class="backbtn" data-act="back" aria-label="Back">' +
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12 4 L6 10 L12 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button><span class="t">episode</span>' +
      '<button class="iconbtn" data-act="edit-ep" data-id="' + esc(ep.id) + '" aria-label="Edit episode">' +
      '<svg width="17" height="17" viewBox="0 0 20 20" fill="none"><path d="M13.2 3.8 L16.2 6.8 L7 16 L3.6 16.4 L4 13 Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button></div>';

    html += '<div class="ephead">' + artHTML(ep, "big") +
      '<div class="eptext"><h2>' + esc(ep.title) + "</h2>" +
      '<span class="epmeta">' + epMetaHTML(ep) + '<span class="sep">·</span><span>' + when(ep.createdAt) + "</span></span></div></div>";

    html += '<div class="row" style="margin-bottom:12px">' +
      (isLive
        ? '<button class="ghost danger" data-act="stop" style="flex:1">Stop listening</button>'
        : '<button class="primary" data-act="play" data-id="' + esc(ep.id) + '" style="flex:1">Listen to this</button>') +
      '<button class="ghost" data-act="ep-done" data-id="' + esc(ep.id) + '">' +
        (ep.status === "done" ? "Back to queue" : "Finished") + "</button></div>";

    html += noticeHTML() + formHTML();

    html += '<div class="seg">' +
      '<button class="segbtn" data-act="ep-seg" data-seg="notes" aria-pressed="' + (ui.epSeg === "notes") + '">Notes · ' + notes.length + "</button>" +
      '<button class="segbtn" data-act="ep-seg" data-seg="words" aria-pressed="' + (ui.epSeg === "words") + '">Words · ' + words.length + "</button></div>";

    if(ui.epSeg === "notes"){
      html += ui.panel === "note"
        ? '<div class="form"><textarea id="note-box" placeholder="What do you want to remember?" aria-label="Note"></textarea>' +
          '<div class="row"><button class="primary" data-act="note-save" data-id="' + esc(ep.id) + '">Save note</button>' +
          '<button class="ghost" data-act="panel-close">Cancel</button></div></div>'
        : '<button class="compose" data-act="note-open">' +
          '<svg width="17" height="17" viewBox="0 0 18 18" fill="none"><path d="M9 3.5 V14.5 M3.5 9 H14.5" stroke="var(--accent)" stroke-width="1.7" stroke-linecap="round"/></svg>' +
          "<span>Add a note to this episode&hellip;</span></button>";
      html += notes.length
        ? '<div class="list">' + notes.map(function(e){ return cardHTML(e, ep); }).join("") + "</div>"
        : '<div class="empty">No notes from this one yet. Say &ldquo;note that&rdquo; while listening, or write one above.</div>';
    }else{
      html += words.length
        ? '<div class="list">' + words.map(function(e){ return cardHTML(e, ep); }).join("") + "</div>"
        : '<div class="empty">No words caught here yet.</div>';
    }

    var coming = idx ? turnUpIn(ep) : [];
    if(coming.length){
      html += '<div class="block"><h3>Your words turn up here</h3>' +
        "<p>" + coming.length + (coming.length === 1 ? " word you" : " words you") +
        " saved elsewhere " + (coming.length === 1 ? "appears" : "appear") +
        " in this episode. Worth a look before you press play.</p>" +
        '<div class="list">' + coming.map(function(c){
          return '<article class="card again-card">' +
            '<div class="head"><span class="word small">' + esc(c.entry.word) + "</span>" +
            stampHTML(ep, c.t) +
            (c.entry.meaning ? "" : '<span class="pending">meaning pending</span>') + "</div>" +
            (c.entry.meaning ? '<p class="meaning small">' + esc(c.entry.meaning) + "</p>" : "") +
            '<p class="quote">&ldquo;' + esc(c.sentence) + "&rdquo;</p></article>";
        }).join("") + "</div></div>";
    }

    if(idx){
      html += '<div class="block"><h3>Transcript</h3><p>' + idx.sentences.length + " sentences, " +
        idx.words + " distinct words" + (idx.timestamps ? ", timestamps" : ", no timestamps") + ".</p>" +
        '<div class="row"><button class="ghost" data-act="rematch" data-id="' + esc(ep.id) + '">Re-match my words</button>' +
        '<button class="ghost" data-act="edit-ep" data-id="' + esc(ep.id) + '">Replace transcript</button></div></div>';
    }
    return html;
  }

  /* ---- Notes ---- */

  function viewNotes(){
    var html = mastheadHTML("Notes", store.entries.filter(function(e){ return e.kind === "note"; }).length + " kept",
      '<button class="iconbtn" data-act="settings" aria-label="Settings">' +
      '<svg width="17" height="17" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M10 2.6 V5 M10 15 V17.4 M17.4 10 H15 M5 10 H2.6 M15.2 4.8 L13.5 6.5 M6.5 13.5 L4.8 15.2 M15.2 15.2 L13.5 13.5 M6.5 6.5 L4.8 4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>');

    html += '<input class="search" data-act="search" type="search" placeholder="Search notes" value="' + esc(ui.q) + '" aria-label="Search notes">';
    html += '<div class="chips">' + chipHTML("noteFilter", [["all","All"],["passage","With passage"],["mine","Written by me"]]) + "</div>";
    html += noticeHTML();
    html += '<div id="listbody">' + notesListHTML() + "</div>";
    return html;
  }

  function notesListHTML(){
    var q = ui.q.toLowerCase();
    var notes = store.entries.filter(function(e){
      if(e.kind !== "note") return false;
      if(ui.noteFilter === "passage" && !e.passage) return false;
      if(ui.noteFilter === "mine" && e.source === "voice") return false;
      if(q && (e.text + " " + e.passage).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    if(!notes.length){
      return '<div class="empty"><strong>' + (ui.q ? "Nothing matches." : "No notes yet.") + "</strong>" +
        (ui.q ? "Try another search." : "While listening, say &ldquo;note that&rdquo; and then the thought. Or open an episode and write one.") + "</div>";
    }
    return '<div class="list">' + groupedHTML(notes) + "</div>";
  }

  /* ---- Words ---- */

  function viewWords(){
    var words = store.entries.filter(function(e){ return e.kind !== "note"; });
    var pending = words.filter(function(e){ return !e.meaning; });

    var known = words.filter(function(e){ return e.known; }).length;
    var html = mastheadHTML("Words", words.length + " caught · " + known + " yours",
      (pending.length
        ? '<button class="ghost small" data-act="copy-words">Explain ' + pending.length + "</button>"
        : '<button class="iconbtn" data-act="settings" aria-label="Settings">' +
          '<svg width="17" height="17" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.5"/>' +
          '<path d="M10 2.6 V5 M10 15 V17.4 M17.4 10 H15 M5 10 H2.6 M15.2 4.8 L13.5 6.5 M6.5 13.5 L4.8 15.2 M15.2 15.2 L13.5 13.5 M6.5 6.5 L4.8 4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>'));

    html += '<input class="search" data-act="search" type="search" placeholder="Search words" value="' + esc(ui.q) + '" aria-label="Search words">';
    html += '<div class="chips">' + chipHTML("wordFilter", [["all","All"],["pending","No meaning"],["learning","Learning"],["known","Known"]]) + "</div>";
    html += noticeHTML();

    if(ui.panel === "defs"){
      html += '<div class="form"><textarea id="defs-box" placeholder=\'Paste the JSON Claude gives you\' aria-label="Paste definitions"></textarea>' +
        '<div class="row"><button class="primary" data-act="apply-defs">Add these meanings</button>' +
        '<button class="ghost" data-act="panel-close">Cancel</button></div></div>';
    }

    html += '<div id="listbody">' + wordsListHTML() + "</div>";

    html += '<div class="block"><h3>Getting the meanings</h3>' +
      "<p>Copy the unexplained words, paste them into any Claude chat, then paste the reply back here. " +
      "They keep their sentences, so the meaning matches how you heard it.</p>" +
      '<div class="row"><button class="ghost" data-act="copy-words">Copy for Claude</button>' +
      '<button class="ghost" data-act="panel-defs">Paste definitions</button>' +
      '<button class="ghost" data-act="settings">Settings</button></div></div>';
    return html;
  }

  function wordsListHTML(){
    var q = ui.q.toLowerCase();
    var words = store.entries.filter(function(e){
      if(e.kind === "note") return false;
      if(ui.wordFilter === "pending" && e.meaning) return false;
      if(ui.wordFilter === "learning" && (!e.meaning || e.known)) return false;
      if(ui.wordFilter === "known" && !e.known) return false;
      if(q && (e.word + " " + e.sentence + " " + e.meaning).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    if(!words.length){
      return '<div class="empty"><strong>' + (ui.q || ui.wordFilter !== "all" ? "Nothing matches." : "No words yet.") + "</strong>" +
        (ui.q || ui.wordFilter !== "all" ? "Try another filter." : "Start an episode and say &ldquo;save&rdquo; followed by a word.") + "</div>";
    }
    return '<div class="list">' + groupedHTML(words) + "</div>";
  }

  function groupedHTML(items){
    var html = "", lastEp = "\u0000-none";
    items.forEach(function(e){
      if(e.episodeId !== lastEp){
        lastEp = e.episodeId;
        var ep = episodeById(e.episodeId);
        var n = items.filter(function(x){ return x.episodeId === lastEp; }).length;
        html += '<div class="group"><button class="t" data-act="open-ep" data-id="' + esc(e.episodeId) +
          '" style="background:none;border:0;padding:0;cursor:pointer;text-align:left;max-width:70%">' +
          esc(ep ? ep.title : "Unfiled") + '</button><span class="rule"></span><span class="n">' + n + "</span></div>";
      }
      html += cardHTML(e, episodeById(e.episodeId));
    });
    return html;
  }

  function chipHTML(key, opts){
    return opts.map(function(o){
      return '<button class="chip" data-act="filter" data-key="' + key + '" data-val="' + o[0] + '" aria-pressed="' +
        (ui[key] === o[0]) + '">' + o[1] + "</button>";
    }).join("");
  }

  /* The one thing only you can judge: whether the word is yours now.
     Marking it stops the re-encounter feature from surfacing it again. */
  function knowHTML(e){
    if(e.known){
      return '<button class="knownchip" data-act="toggle-known" data-id="' + esc(e.id) + '" ' +
        'aria-pressed="true" title="Mark as still learning">' +
        '<svg width="11" height="11" viewBox="0 0 12 12" fill="none">' +
        '<path d="M2.5 6.4 L4.7 8.6 L9.5 3.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        "known</button>";
    }
    if(!e.meaning) return "";      // nothing to claim to know yet
    return '<button class="knowbtn" data-act="toggle-known" data-id="' + esc(e.id) + '" aria-pressed="false">I know this</button>';
  }

  function againHTML(e){
    var also = alsoIn(e);
    if(!also.length) return "";
    var first = also[0], ep = episodeById(first.epId);
    return '<div class="again-box"><div class="again-head">' +
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none">' +
      '<path d="M2.5 8 A5.5 5.5 0 1 1 4.6 12.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M2 4.5 V8 H5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "<span>came up again in " + esc(ep.title) +
      (also.length > 1 ? " +" + (also.length - 1) + " more" : "") + "</span>" +
      stampHTML(ep, first.t) + "</div>" +
      '<p class="quote soft">&ldquo;' + esc(first.sentence) + "&rdquo;</p></div>";
  }

  function cardHTML(e, ep){
    var footEnd = '<span class="grow"></span>' +
      '<button data-act="edit-entry" data-id="' + esc(e.id) + '">Edit</button>' +
      '<button class="del" data-act="del-entry" data-id="' + esc(e.id) + '">Delete</button></div>';

    if(e.kind === "note"){
      return '<article class="card note"><div class="kind">note</div>' +
        '<p class="notebody">' + esc(e.text) + "</p>" +
        (e.passage ? '<p class="quote soft">&ldquo;' + esc(e.passage) + "&rdquo;</p>" : "") +
        '<div class="foot">' + stampHTML(ep, e.t) + "<span>" + when(e.createdAt) + "</span>" +
        "<span>" + (e.source === "voice" ? "spoken" : "typed") + "</span>" + footEnd + "</article>";
    }
    return '<article class="card' + (e.known ? " known" : "") + '">' +
      '<div class="head"><span class="word">' + esc(e.word) + "</span>" +
      (e.ipa ? '<span class="ipa">' + esc(e.ipa) + "</span>" : "") +
      (e.pos ? '<span class="pos">' + esc(e.pos) + "</span>" : (e.meaning ? "" : '<span class="pending">meaning pending</span>')) +
      knowHTML(e) +
      "</div>" +
      (e.heardAs ? '<p class="repair">heard as &ldquo;' + esc(e.heardAs) + "&rdquo;</p>" : "") +
      (e.meaning ? '<p class="meaning">' + esc(e.meaning) + "</p>" : "") +
      (e.sentence ? '<p class="quote">&ldquo;' + esc(e.sentence) + "&rdquo;</p>" : "") +
      (e.example ? '<p class="example">' + esc(e.example) + "</p>" : "") +
      againHTML(e) +
      '<div class="foot">' + stampHTML(ep, e.t) + "<span>" + when(e.createdAt) + "</span>" +
      "<span>" + (e.via === "transcript" ? "transcript" : e.source === "voice" ? "voice" : "typed") + "</span>" +
      footEnd + "</article>";
  }

  /* ---- episode form ---- */

  function formHTML(){
    if(!ui.form) return "";
    var ep = ui.form === "new" ? null : episodeById(ui.form);
    return '<form class="form" data-act="save-ep" data-id="' + esc(ep ? ep.id : "") + '" autocomplete="off">' +
      '<div class="formhead"><span class="cue">' + (ep ? "editing" : "new episode") + "</span>" +
      (ep ? '<button type="button" class="ghost small danger" data-act="delete-ep" data-id="' + esc(ep.id) + '">Delete</button>' : "") +
      "</div>" +
      '<input id="f-title" type="text" placeholder="Episode or video title" value="' + esc(ep ? ep.title : "") + '" aria-label="Title">' +
      '<input id="f-url" type="url" inputmode="url" placeholder="Link — optional, makes timestamps tappable" value="' + esc(ep ? ep.url : "") + '" aria-label="Link">' +
      '<textarea id="f-transcript" placeholder="Paste the transcript before you listen. Plain text or a raw .vtt caption file." aria-label="Transcript">' + esc(ep ? ep.transcript : "") + "</textarea>" +
      '<div class="row"><button class="primary" type="submit">' + (ep ? "Save changes" : "Start this episode") + "</button>" +
      '<button type="button" class="ghost" data-act="paste-transcript">Paste</button>' +
      '<button type="button" class="ghost" data-act="form-close">Cancel</button></div>' +
      '<p class="result" id="f-result" hidden></p></form>';
  }

  /* ---- settings ---- */

  function viewSettings(){
    return '<div class="nav"><button class="backbtn" data-act="back" aria-label="Back">' +
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12 4 L6 10 L12 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button><span class="t">settings</span></div>' +
      '<div class="block"><h3>Words from your phone</h3>' +
      '<p>Dictated words piling up in a note or a Siri shortcut? Paste them here, one per line. A dash adds the sentence &mdash; <span class="miss">quandary &mdash; a real quandary</span>.</p>' +
      '<textarea id="batch-box" placeholder="serendipity&#10;debacle &mdash; the whole rollout was a debacle"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="primary" data-act="apply-batch">Add them</button></div>' +
      '<p class="result" id="batch-result" hidden></p></div>' +

      '<div class="block"><h3>Your data</h3>' +
      "<p>Everything lives on this device. Download a backup before clearing Safari&rsquo;s data &mdash; and use <b>Restore</b> to take in a queue file prepared on your Mac, which is how episodes and their transcripts get here without any typing.</p>" +
      '<div class="row"><button class="ghost" data-act="backup">Download backup</button>' +
      '<button class="ghost" data-act="restore">Restore / import</button>' +
      '<button class="ghost" data-act="export">Copy everything</button></div>' +
      '<input id="restore-file" type="file" accept="application/json,.json" hidden>' +
      '<p class="result" id="data-result" hidden></p></div>' +

      '<div class="block"><h3>Microphone not working?</h3>' +
      "<p>Run the check and copy the report &mdash; it says which step the browser refuses, instead of failing silently.</p>" +
      '<div class="row"><button class="ghost" data-act="diag">Run check</button>' +
      '<button class="ghost" data-act="diag-copy">Copy report</button></div>' +
      '<pre id="diag-log" class="log">Not run yet.</pre></div>' +

      '<div class="status"><span class="dot"></span><span>' + store.entries.length + " saved on this device · v" + VERSION + "</span></div>";
  }

  /* ---- render ---- */

  function render(){
    var v = $("#view");
    var html;
    if(ui.settings) html = viewSettings();
    else if(ui.ep) html = viewEpisode();
    else if(ui.tab === "notes") html = viewNotes();
    else if(ui.tab === "words") html = viewWords();
    else html = viewListen();
    v.innerHTML = html;
    renderTabs();
  }

  function renderList(){
    var body = $("#listbody");
    if(!body) return render();
    body.innerHTML = ui.tab === "notes" ? notesListHTML() : wordsListHTML();
  }

  var toastTimer = null;
  function toast(msg){
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    $("#live-region").textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 2400);
  }
  function notice(msg, warn){ ui.notice = msg || ""; ui.noticeWarn = !!warn; }

  /* ============================ speech ============================ */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, wantListening = false, restartTimer = null, wakeLock = null;
  var heard = [];
  var WORD_TRIGGERS = ["save", "catch"];
  var NOTE_TRIGGERS = ["note that", "note this", "remember that", "make a note"];
  var STOP = {"the":1,"a":1,"an":1,"it":1,"this":1,"that":1,"word":1,"and":1,"is":1,"to":1};
  var logLines = [];

  function logLine(msg){
    var d = new Date();
    logLines.push(("0"+d.getMinutes()).slice(-2) + ":" + ("0"+d.getSeconds()).slice(-2) + "  " + msg);
    if(logLines.length > 60) logLines.shift();
    var el = $("#diag-log");
    if(el && el.dataset.live === "1"){ el.textContent = logLines.join("\n"); el.scrollTop = el.scrollHeight; }
  }

  function ribbon(text){
    var el = $("#ribbon");
    if(el) el.innerHTML = "<bdi>" + esc(text || "Nothing yet.") + "</bdi>";
  }

  function contextBefore(cutoff){
    var out = [];
    for(var i = heard.length - 1; i >= 0; i--){
      if(heard[i].t >= cutoff) continue;
      if(Date.now() - heard[i].t > 45000) break;
      out.unshift(heard[i].text);
      if(out.join(" ").length > 320) break;
    }
    return out.join(" ").trim();
  }

  function lastTrigger(lower, triggers){
    var best = -1, used = "";
    triggers.forEach(function(t){
      var i = lower.lastIndexOf(" " + t + " ");
      if(i > best){ best = i; used = t; }
    });
    return { at:best, trigger:used };
  }

  function handleFinal(text){
    var clean = text.trim();
    if(!clean) return;
    ribbon(clean);
    var lower = " " + clean.toLowerCase() + " ";

    var n = lastTrigger(lower, NOTE_TRIGGERS);
    if(n.at !== -1){
      var body = clean.slice(n.at + n.trigger.length + 1).trim();
      if(body.length > 1 && addNote(body, "voice")){
        toast("Note saved");
        buzz(); render();
      }
      return;
    }

    var w = lastTrigger(lower, WORD_TRIGGERS);
    if(w.at === -1){
      heard.push({ text:clean, t:Date.now() });
      if(heard.length > 60) heard.shift();
      return;
    }

    var rest = clean.slice(w.at + w.trigger.length + 1).trim().replace(/^(the\s+word\s+|word\s+)/i, "").trim();
    var tokens = rest.split(/\s+/).filter(Boolean);
    if(!tokens.length) return;
    var word = tokens[0];
    if(STOP[cleanWord(word)] && tokens.length > 1){ tokens.shift(); word = tokens[0]; }
    var spoken = tokens.slice(1).join(" ").trim() || contextBefore(Date.now());

    var added = addWord(word, spoken, "voice");
    if(added){
      toast(added.heardAs ? "Caught “" + added.word + "” (heard “" + added.heardAs + "”)" : "Caught “" + added.word + "”");
      buzz(); render();
    }
  }

  function buzz(){ if(navigator.vibrate) try{ navigator.vibrate(35); }catch(e){} }

  function buildRecognizer(){
    var r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = "en-US";
    r.onstart = function(){ logLine("recognition started"); };
    r.onaudiostart = function(){ logLine("microphone open"); };
    r.onspeechstart = function(){ logLine("speech detected"); };
    r.onresult = function(ev){
      var interim = "";
      for(var i = ev.resultIndex; i < ev.results.length; i++){
        if(ev.results[i].isFinal) handleFinal(ev.results[i][0].transcript);
        else interim += ev.results[i][0].transcript;
      }
      if(interim) ribbon(interim);
    };
    r.onerror = function(ev){
      logLine("ERROR: " + (ev.error || "unknown"));
      if(ev.error === "not-allowed" || ev.error === "service-not-allowed"){
        wantListening = false;
        notice("The browser refused the microphone (<code>" + esc(ev.error) + "</code>). Run the check in Settings.", true);
        render();
      }else if(ev.error === "network"){
        notice("Speech recognition could not reach its service. It will keep retrying.", true);
        render();
      }
    };
    r.onend = function(){
      logLine("recognition ended" + (wantListening ? " — restarting" : ""));
      if(wantListening){
        clearTimeout(restartTimer);
        restartTimer = setTimeout(function(){ try{ r.start(); }catch(e){} }, 350);
      }else render();
    };
    return r;
  }

  async function holdScreen(){
    try{ if(navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); }catch(e){}
  }
  function releaseScreen(){ try{ if(wakeLock){ wakeLock.release(); wakeLock = null; } }catch(e){} }

  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState === "visible" && wantListening){
      wakeLock = null; holdScreen();
      clearTimeout(restartTimer);
      restartTimer = setTimeout(function(){ if(rec) try{ rec.start(); }catch(e){} }, 300);
    }
  });

  function startListening(epId){
    if(!SR){
      notice("This browser cannot listen. Chrome on Android or Safari on iOS can.", true);
      render(); return;
    }
    if(epId) store.activeId = epId;
    if(!rec) rec = buildRecognizer();
    wantListening = true;
    logLine("start requested by tap");
    try{ rec.start(); }catch(e){ logLine("start() threw: " + (e && e.name)); }
    holdScreen();
    save();
    notice(indexFor(activeEpisode())
      ? "Keep this page in front while you listen — the microphone only works on the visible page."
      : "No transcript on this one, so words are saved exactly as heard. Add one later and re-match.");
    ui.ep = null; ui.tab = "listen";
    render();
  }

  function stopListening(){
    wantListening = false;
    clearTimeout(restartTimer);
    if(rec) try{ rec.stop(); }catch(e){}
    releaseScreen();
    notice("");
    render();
  }

  /* ============================ actions ============================ */

  function val(sel){ var el = $(sel); return el ? el.value : ""; }

  var actions = {
    tab: function(el){
      ui.settings = false; ui.ep = null; ui.form = null; ui.panel = null; ui.q = ""; ui.notice = "";
      ui.tab = el.dataset.tab; render();
    },
    back: function(){ ui.settings = false; ui.ep = null; ui.form = null; ui.panel = null; ui.notice = ""; render(); },
    settings: function(){ ui.settings = true; render(); },

    mic: function(){ wantListening ? stopListening() : startListening(); },
    play: function(el){ startListening(el.dataset.id); },
    stop: function(){ stopListening(); },

    "open-ep": function(el){
      ui.ep = el.dataset.id; ui.settings = false; ui.form = null; ui.panel = null; ui.epSeg = "notes";
      render(); window.scrollTo(0,0);
    },
    "new-ep": function(){ ui.form = "new"; render(); setTimeout(function(){ var f = $("#f-title"); if(f) f.focus(); }, 30); },
    "edit-ep": function(el){
      ui.form = el.dataset.id;
      if(!ui.ep && !ui.settings) ui.tab = "listen";
      render();
      setTimeout(function(){ var f = $("#f-title"); if(f) f.focus(); }, 30);
    },
    "form-close": function(){ ui.form = null; render(); },

    "save-ep": function(el, ev){
      if(ev) ev.preventDefault();
      var id = el.dataset.id;
      var title = val("#f-title").trim(), url = val("#f-url").trim(), transcript = val("#f-transcript").trim();
      var out = $("#f-result");
      if(!title && !url){
        if(out){ out.hidden = false; out.textContent = "Give it a title so you can find it later."; }
        return;
      }
      var ep = id ? episodeById(id) : null, isNew = !ep;
      if(isNew){ ep = normEpisode({ id:newId("ep"), createdAt:Date.now() }); store.episodes.unshift(ep); }
      var changed = (ep.transcript || "") !== transcript;
      ep.title = title || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60);
      ep.url = url; ep.transcript = transcript; ep.updatedAt = Date.now();
      delete indexes[ep.id];
      save();

      if(isNew){
        store.activeId = ep.id; save();
        ui.form = null;
        var coming = turnUpIn(ep);
        if(coming.length){
          notice("<b>" + coming.length + "</b> " + (coming.length === 1 ? "word you" : "words you") +
            " saved before " + (coming.length === 1 ? "turns" : "turn") + " up in this episode: " +
            "<b>" + coming.slice(0,6).map(function(c){ return esc(c.entry.word); }).join(", ") + "</b>" +
            (coming.length > 6 ? " and " + (coming.length - 6) + " more" : "") + ".");
        }
        toast("Queued “" + ep.title + "”");
        render();
      }else{
        ui.form = null;
        if(changed && transcript){
          rematch(ep);
          var back = turnUpIn(ep);
          if(back.length) notice(ui.notice + " <b>" + back.length + "</b> of your older " +
            (back.length === 1 ? "word turns" : "words turn") + " up in this one too.");
          render();
        }else{ toast("Saved"); render(); }
      }
    },

    "delete-ep": function(el){
      var ep = episodeById(el.dataset.id);
      if(!ep) return;
      var mine = entriesOf(ep.id);
      var msg = mine.length
        ? "Delete “" + ep.title + "” and the " + mine.length + " " + (mine.length === 1 ? "item" : "items") +
          " caught in it?\n\nThis cannot be undone."
        : "Delete “" + ep.title + "”?";
      if(!window.confirm(msg)) return;
      store.entries = store.entries.filter(function(e){ return e.episodeId !== ep.id; });
      store.episodes = store.episodes.filter(function(e){ return e.id !== ep.id; });
      delete indexes[ep.id];
      if(store.activeId === ep.id){ store.activeId = null; wantListening = false; }
      save();
      ui.form = null; ui.ep = null;
      toast("Deleted “" + ep.title + "”");
      render();
    },

    "ep-done": function(el){
      var ep = episodeById(el.dataset.id);
      if(!ep) return;
      ep.status = ep.status === "done" ? "queued" : "done";
      ep.updatedAt = Date.now();
      save();
      toast(ep.status === "done" ? "Marked finished" : "Back in the queue");
      render();
    },
    "toggle-done": function(){ ui.showDone = !ui.showDone; render(); },
    "ep-seg": function(el){ ui.epSeg = el.dataset.seg; render(); },

    "note-open": function(){ ui.panel = "note"; render(); setTimeout(function(){ var b = $("#note-box"); if(b) b.focus(); }, 30); },
    "note-save": function(el){
      var text = val("#note-box");
      if(!addNote(text, "typed", el.dataset.id)){ toast("Write the note first"); return; }
      ui.panel = null;
      toast("Note added");
      render();
    },
    "panel-close": function(){ ui.panel = null; render(); },
    "panel-defs": function(){ ui.panel = "defs"; render(); setTimeout(function(){ var b = $("#defs-box"); if(b) b.focus(); }, 30); },

    filter: function(el){ ui[el.dataset.key] = el.dataset.val; render(); },

    "edit-entry": function(el){
      var e = store.entries.filter(function(x){ return x.id === el.dataset.id; })[0];
      if(!e) return;
      var next;
      if(e.kind === "note"){
        next = window.prompt("Note:", e.text || "");
        if(next === null) return;
        e.text = next.trim();
      }else{
        next = window.prompt("The sentence you heard “" + e.word + "” in:", e.sentence || "");
        if(next === null) return;
        e.sentence = next.trim();
      }
      e.updatedAt = Date.now();
      save(); render();
    },
    "toggle-known": function(el){
      var e = store.entries.filter(function(x){ return x.id === el.dataset.id; })[0];
      if(!e) return;
      e.known = !e.known;
      e.knownAt = e.known ? Date.now() : null;
      e.updatedAt = Date.now();
      save();
      toast(e.known ? "“" + e.word + "” is yours" : "Back to learning");
      render();
    },

    "del-entry": function(el){
      store.entries = store.entries.filter(function(x){ return x.id !== el.dataset.id; });
      save(); toast("Deleted"); render();
    },

    rematch: function(el){ rematch(episodeById(el.dataset.id)); },

    "paste-transcript": async function(){
      var out = $("#f-result");
      try{
        var text = await navigator.clipboard.readText();
        if(!text || text.trim().length < 40){
          if(out){ out.hidden = false; out.textContent = "Nothing like a transcript on the clipboard."; }
          return;
        }
        $("#f-transcript").value = text;
        if(out){
          out.hidden = false;
          out.innerHTML = "Pasted <b>" + text.trim().split(/\s+/).length.toLocaleString() + "</b> words.";
        }
      }catch(e){
        if(out){ out.hidden = false; out.textContent = "The browser would not hand over the clipboard — long-press the box and paste."; }
      }
    },

    "copy-words": function(){
      var pending = store.entries.filter(function(e){ return e.kind !== "note" && !e.meaning; });
      if(!pending.length){ toast("Every word already has a meaning"); return; }
      var payload = pending.map(function(e){
        var o = { word:e.word };
        if(e.sentence) o.heard_in = e.sentence;
        return o;
      });
      copy("These are English words I heard in a podcast but did not know. They were captured by speech " +
        "recognition, so some are MISSPELLED — work out the real word from the spelling and any sentence " +
        "given, and put it in \"corrected\". Keep \"word\" exactly as I sent it so I can match them up.\n\n" +
        "For each one give a short plain-English meaning (one or two sentences, matching how it is used " +
        "where I heard it), the IPA pronunciation, the part of speech, and one fresh example sentence. " +
        "If a word is too garbled to identify, set \"corrected\" to \"?\" and leave the rest empty.\n\n" +
        "Reply with ONLY a JSON array like " +
        '[{"word":"","corrected":"","pos":"","ipa":"","meaning":"","example":""}] and nothing else.\n\n' +
        JSON.stringify(payload, null, 2), "Copied — paste it into Claude");
    },

    "apply-defs": function(){
      var raw = val("#defs-box").trim();
      var a = raw.indexOf("["), b = raw.lastIndexOf("]");
      if(a === -1 || b === -1){ toast("That does not look like the JSON list"); return; }
      var data;
      try{ data = JSON.parse(raw.slice(a, b+1)); }catch(e){ toast("Could not read that JSON"); return; }
      if(!Array.isArray(data)){ toast("Expected a list"); return; }
      var applied = 0, fixed = 0, unknown = 0;
      data.forEach(function(d){
        var w = cleanWord(d && d.word);
        if(!w) return;
        var corrected = cleanWord(d && d.corrected);
        if(corrected === "?" || (d && d.corrected === "?")){ unknown++; return; }
        var def = pickDef(d);
        store.entries.forEach(function(e){
          if(e.kind === "note" || e.word !== w) return;
          if(e.meaning && !def.meaning) return;
          if(corrected && corrected !== e.word){
            e.heardAs = e.heardAs || e.word;    // keep what the microphone thought
            e.word = corrected;
            fixed++;
          }
          Object.assign(e, def);
          e.updatedAt = Date.now();
          applied++;
        });
      });
      if(!applied && !unknown){ toast("None of those words are in your list"); return; }
      save(); ui.panel = null;
      notice("<b>" + applied + "</b> " + (applied === 1 ? "meaning" : "meanings") + " added" +
        (fixed ? ", <b>" + fixed + "</b> " + (fixed === 1 ? "spelling" : "spellings") + " corrected" : "") +
        (unknown ? ", " + unknown + " too garbled to identify" : "") + ".");
      toast(applied + (applied === 1 ? " meaning added" : " meanings added"));
      render();
    },

    "apply-batch": function(){
      var out = $("#batch-result");
      var added = 0, skipped = 0;
      val("#batch-box").split(/[\n\r;]+/).forEach(function(line){
        var raw = line.trim().replace(/^[-*•\d.)\s]+/, "").trim();
        if(!raw) return;
        var parts = raw.split(/\s+[—–-]\s+|\s*[:|\t]\s*/);
        var word = parts.shift(), sentence = parts.join(" ").trim();
        var w = cleanWord(word);
        if(store.entries.filter(function(e){ return e.kind !== "note" && e.word === w && e.episodeId === store.activeId; }).length){
          skipped++; return;
        }
        if(addWord(word, sentence, "typed")) added++; else skipped++;
      });
      if(out){
        out.hidden = false;
        out.innerHTML = "<b>" + added + "</b> " + (added === 1 ? "word added" : "words added") +
          (skipped ? ", " + skipped + " skipped" : "") + ".";
      }
      if(added){ $("#batch-box").value = ""; toast(added + " added"); }
    },

    backup: function(){
      var payload = JSON.stringify({ app:"earshot", v:3, exportedAt:new Date().toISOString(),
        episodes:store.episodes, entries:store.entries }, null, 2);
      var url = URL.createObjectURL(new Blob([payload], {type:"application/json"}));
      var a = document.createElement("a");
      a.href = url; a.download = "earshot-" + new Date().toISOString().slice(0,10) + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
      toast("Backup downloaded");
    },
    restore: function(){ var f = $("#restore-file"); if(f) f.click(); },

    export: function(){
      if(!store.entries.length){ toast("Nothing to copy yet"); return; }
      var byEp = {};
      store.entries.forEach(function(e){ (byEp[e.episodeId] = byEp[e.episodeId] || []).push(e); });
      copy(Object.keys(byEp).map(function(id){
        var ep = episodeById(id);
        var head = (ep ? ep.title : "Unfiled") + (ep && ep.url ? "\n" + ep.url : "");
        return head + "\n" + "-".repeat(Math.min(60, head.split("\n")[0].length)) + "\n" +
          byEp[id].map(function(e){
            var ts = (e.t !== null && e.t !== undefined) ? "[" + fmtTime(e.t) + "] " : "";
            if(e.kind === "note") return ts + "NOTE: " + e.text + (e.passage ? "\n    while hearing: “" + e.passage + "”" : "");
            return ts + e.word + (e.pos ? " (" + e.pos + ")" : "") + (e.ipa ? " " + e.ipa : "") +
              (e.meaning ? "\n    " + e.meaning : "\n    [meaning pending]") +
              (e.sentence ? "\n    heard: “" + e.sentence + "”" : "");
          }).join("\n\n");
      }).join("\n\n\n"), "Everything copied");
    },

    diag: function(){ runDiag(); },
    "diag-copy": function(){ var el = $("#diag-log"); if(el) copy(el.textContent, "Report copied"); }
  };

  function rematch(ep){
    if(!ep){ toast("Choose an episode first"); return; }
    var idx = indexFor(ep);
    if(!idx){ toast("This episode has no transcript"); return; }
    var matched = 0, repaired = 0, placed = 0, missed = [];

    store.entries.forEach(function(e){
      if(e.episodeId !== ep.id) return;
      if(e.kind === "note"){
        if(!e.passage && e.text){
          var loc = locate(idx, e.text);
          if(loc){ e.passage = loc.text; e.t = loc.t; e.updatedAt = Date.now(); placed++; }
        }
        return;
      }
      var hit = findInIndex(idx, e.word), used = e.word;
      if(!hit && !e.meaning){
        var alt = nearestInVocab(idx.vocab, e.word);
        if(alt && alt !== e.word){
          hit = findInIndex(idx, alt);
          if(hit){ e.heardAs = e.word; used = alt; repaired++; }
        }
      }
      if(hit){
        e.word = used; e.sentence = clipAround(hit.text, used); e.t = hit.t;
        e.via = "transcript"; e.updatedAt = Date.now(); matched++;
      }else missed.push(e.word);
    });

    save();
    notice("<b>" + matched + "</b> " + (matched === 1 ? "word" : "words") + " matched" +
      (repaired ? ", <b>" + repaired + "</b> " + (repaired === 1 ? "spelling fixed" : "spellings fixed") : "") +
      (placed ? ", <b>" + placed + "</b> " + (placed === 1 ? "note placed" : "notes placed") : "") + "." +
      (missed.length ? " Not in this transcript: <span class=\"miss\">" + esc(missed.slice(0,10).join(", ")) +
        (missed.length > 10 ? " +" + (missed.length - 10) : "") + "</span>" : ""));
    render();
    if(matched) toast(matched + (matched === 1 ? " sentence updated" : " sentences updated"));
  }

  function copy(text, okMsg){
    function fallback(){
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand("copy"); toast(okMsg); }catch(e){ toast("Could not copy"); }
      document.body.removeChild(ta);
    }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ toast(okMsg); }, fallback);
    }else fallback();
  }

  function restoreFile(file){
    var out = $("#data-result");
    var reader = new FileReader();
    reader.onload = function(){
      var data;
      try{ data = JSON.parse(reader.result); }
      catch(e){ if(out){ out.hidden = false; out.textContent = "That is not a valid Earshot backup."; } return; }
      var incoming = Array.isArray(data) ? data : (data.entries || []);
      var incomingEps = (data.episodes || []).filter(function(e){ return e && e.id; });
      if(!incoming.length && !incomingEps.length){
        if(out){ out.hidden = false; out.textContent = "Nothing to import from that file."; }
        return;
      }
      var before = store.entries.length, epsBefore = store.episodes.length;
      var known = {};
      store.episodes.forEach(function(e){ known[e.id] = 1; });
      incomingEps.forEach(function(e){ if(!known[e.id]) store.episodes.push(normEpisode(e)); });
      if(!(data.episodes || []).length){
        var legacy = episodeById("ep-earlier");
        if(!legacy){ legacy = normEpisode({ id:"ep-earlier", title:"Earlier words", createdAt:Date.now() }); store.episodes.push(legacy); }
        incoming.forEach(function(e){ if(!e.episodeId) e.episodeId = legacy.id; e.kind = e.kind || "word"; });
      }
      store.entries = mergeEntries(store.entries, incoming);
      applySeed(); indexes = {}; save(); render();
      var newEps = store.episodes.length - epsBefore, newWords = store.entries.length - before;
      var o = $("#data-result");
      if(o){
        o.hidden = false;
        o.innerHTML = "Imported — " +
          (newEps ? "<b>" + newEps + "</b> " + (newEps === 1 ? "episode" : "episodes") : "") +
          (newEps && newWords ? ", " : "") +
          (newWords ? "<b>" + newWords + "</b> " + (newWords === 1 ? "word" : "words") : "") +
          (!newEps && !newWords ? "nothing new — you already had all of it" : "") + ".";
      }
      toast(newEps && !newWords ? newEps + (newEps === 1 ? " episode queued" : " episodes queued") : "Backup restored");
    };
    reader.readAsText(file);
  }

  /* ---- diagnostics ---- */

  function diagHeader(){
    var framed = "unknown";
    try{ framed = (window.self !== window.top) ? "YES — inside a frame" : "no"; }
    catch(e){ framed = "YES — cross-origin frame"; }
    return ["EARSHOT MICROPHONE CHECK",
      "user agent: " + navigator.userAgent,
      "page url:   " + location.origin,
      "secure context: " + (window.isSecureContext ? "yes" : "NO — mic blocked without https"),
      "inside a frame: " + framed,
      "standalone (home screen): " + (navigator.standalone === true ? "yes" : "no"),
      "SpeechRecognition API: " + (window.SpeechRecognition ? "yes (standard)" :
        window.webkitSpeechRecognition ? "yes (webkit)" : "NO"),
      "getUserMedia API: " + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? "yes" : "NO"),
      "app version: " + VERSION, "----"].join("\n");
  }

  async function runDiag(){
    var el = $("#diag-log");
    if(!el) return;
    el.dataset.live = "1";
    logLines = [];
    var head = diagHeader();
    el.textContent = head + "\nchecking…";
    function paint(){ el.textContent = head + "\n" + logLines.join("\n"); el.scrollTop = el.scrollHeight; }

    try{
      if(navigator.permissions && navigator.permissions.query){
        var st = await navigator.permissions.query({ name:"microphone" });
        logLine("permission state: " + st.state);
      }else logLine("permission state: not reported");
    }catch(e){ logLine("permission state: not reported (" + (e && e.name) + ")"); }
    paint();

    try{
      var stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      logLine("getUserMedia: OK — microphone opened");
      var tr = stream.getAudioTracks()[0];
      if(tr) logLine("audio track: " + (tr.label || "unnamed") + ", muted=" + tr.muted);
      stream.getTracks().forEach(function(t){ t.stop(); });
    }catch(e){ logLine("getUserMedia FAILED: " + (e && e.name) + " — " + (e && e.message)); }
    paint();

    if(!SR){ logLine("speech recognition unavailable"); paint(); return; }
    logLine("6-second speech test — say a few words now");
    paint();

    await new Promise(function(resolve){
      var t = new SR(), done = false;
      t.continuous = true; t.interimResults = true; t.lang = "en-US";
      function finish(why){ if(done) return; done = true; logLine("test finished (" + why + ")"); try{ t.stop(); }catch(e){} paint(); resolve(); }
      t.onstart = function(){ logLine("test: started"); paint(); };
      t.onaudiostart = function(){ logLine("test: microphone open"); paint(); };
      t.onresult = function(ev){
        var s = "";
        for(var i = ev.resultIndex; i < ev.results.length; i++) s += ev.results[i][0].transcript;
        logLine("test: heard “" + s.trim() + "”"); paint();
      };
      t.onerror = function(ev){ logLine("test ERROR: " + (ev.error || "unknown")); paint(); };
      t.onend = function(){ finish("ended"); };
      try{ t.start(); }catch(e){ logLine("test start() threw: " + (e && e.name)); finish("could not start"); }
      setTimeout(function(){ finish("6s elapsed"); }, 6000);
    });
    logLine("check complete — tap Copy report");
    paint();
  }

  /* ============================ wiring ============================ */

  function dispatch(ev){
    var el = ev.target.closest ? ev.target.closest("[data-act]") : null;
    if(!el) return;
    if(el.tagName === "A") return;
    var fn = actions[el.dataset.act];
    if(!fn) return;
    if(el.tagName === "FORM" && ev.type !== "submit") return;
    if(ev.type === "submit") ev.preventDefault();
    fn(el, ev);
  }

  document.addEventListener("click", function(ev){
    var el = ev.target.closest ? ev.target.closest("[data-act]") : null;
    if(!el || el.tagName === "FORM") return;
    dispatch(ev);
  });
  document.addEventListener("submit", dispatch);
  document.addEventListener("input", function(ev){
    var el = ev.target;
    if(el.dataset && el.dataset.act === "search"){ ui.q = el.value.trim(); renderList(); }
  });
  document.addEventListener("change", function(ev){
    if(ev.target.id === "restore-file" && ev.target.files && ev.target.files[0]){
      restoreFile(ev.target.files[0]);
      ev.target.value = "";
    }
  });
  // broken YouTube thumbnails fall back to the generated gradient underneath
  document.addEventListener("error", function(ev){
    if(ev.target.classList && ev.target.classList.contains("artimg")) ev.target.style.display = "none";
  }, true);

  /* ============================ boot ============================ */

  store = readStore();
  applySeed();
  render();
  save();

  try{
    var p = new URLSearchParams(location.search);
    if(p.get("title") || p.get("url")){
      ui.form = "new";
      render();
      var t = $("#f-title"), u = $("#f-url");
      if(t) t.value = p.get("title") || "";
      if(u) u.value = p.get("url") || "";
      var tr = $("#f-transcript");
      if(tr) tr.focus();
    }
    if(p.get("add")){
      var a = addWord(p.get("add"), p.get("heard") || "", "typed");
      if(a){ toast("Caught “" + a.word + "”"); render(); }
    }
    if(p.get("note") && addNote(p.get("note"), "typed")){ toast("Note saved"); render(); }
    if(p.toString()) history.replaceState(null, "", location.pathname);
  }catch(e){}

  if(!SR){
    notice("This browser cannot listen for you. Chrome on Android and Safari on iOS can — meanwhile add words by hand.", true);
    render();
  }

  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){ navigator.serviceWorker.register("sw.js").catch(function(){}); });
  }
})();
