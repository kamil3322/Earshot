/* Earshot — catch words and thoughts from what you are listening to.
   No build step, no dependencies. Sections in order:
     storage → transcript index → entries → rendering → speech
     → episodes → tools → diagnostics → boot                        */

(function(){
  "use strict";

  /* Definitions Claude has filled in can be seeded here, keyed by lowercase word. */
  var SEED = {};

  var VERSION = "2.2";
  var KEY = "earshot.v2";
  var KEY_V1 = "earshot.v1";
  var $ = function(s){ return document.querySelector(s); };

  /* Bind by selector, and survive a missing element. Without this, one element
     absent from the HTML (a half-deployed update, a stale cached index.html)
     throws and every listener registered after it silently never binds. */
  function on(sel, ev, fn){
    var el = document.querySelector(sel);
    if(!el){ console.warn("Earshot: no element for " + sel + " — that control is inert"); return; }
    el.addEventListener(ev, fn);
  }

  var store = { v:2, episodes:[], entries:[], activeId:null };
  var filter = "all";
  var scopeEpisode = false;
  var query = "";
  var indexes = {};           // episodeId -> {sentences, vocab, count}
  var handKind = "word";

  /* ============================ storage ============================ */

  function newId(prefix){
    return (prefix || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function readStore(){
    try{
      var raw = localStorage.getItem(KEY);
      if(raw){
        var d = JSON.parse(raw);
        return {
          v: 2,
          episodes: d.episodes || [],
          entries: (d.entries || []).filter(function(e){ return e && e.id; }),
          activeId: d.activeId || null
        };
      }
    }catch(e){}
    return migrateV1();
  }

  /* v1 kept a flat list of words. Everything lands in one "Earlier words" episode. */
  function migrateV1(){
    var old = [];
    try{
      var raw = localStorage.getItem(KEY_V1);
      if(raw){
        var d = JSON.parse(raw);
        old = Array.isArray(d) ? d : (d.entries || []);
      }
    }catch(e){}

    if(!old.length) return { v:2, episodes:[], entries:[], activeId:null };

    var ep = {
      id: "ep-earlier",
      title: "Earlier words",
      url: "",
      transcript: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    var moved = old.map(function(e){
      e.episodeId = ep.id;
      e.kind = e.kind || "word";
      return e;
    });
    return { v:2, episodes:[ep], entries:moved, activeId:null };
  }

  function writeStore(){
    try{ localStorage.setItem(KEY, JSON.stringify(store)); }catch(e){}
  }

  function save(){
    writeStore();
    var w = store.entries.filter(function(e){ return e.kind !== "note"; }).length;
    var n = store.entries.length - w;
    setSaved(w + (w === 1 ? " word" : " words") + (n ? ", " + n + (n === 1 ? " note" : " notes") : "") + " on this device · v" + VERSION);
  }

  function setSaved(msg, warn){
    var dot = $("#sync-dot"), txt = $("#sync-text");
    if(!dot || !txt) return;
    dot.className = "dot" + (warn ? " warn" : " ok");
    txt.textContent = msg;
  }

  function mergeEntries(a, b){
    var map = {};
    (a || []).concat(b || []).forEach(function(e){
      if(!e || !e.id) return;
      var prev = map[e.id];
      if(!prev || (e.updatedAt || 0) >= (prev.updatedAt || 0)) map[e.id] = e;
    });
    return Object.keys(map).map(function(k){ return map[k]; })
      .sort(function(x, y){ return (y.createdAt || 0) - (x.createdAt || 0); });
  }

  function episodeById(id){
    return store.episodes.filter(function(e){ return e.id === id; })[0] || null;
  }
  function activeEpisode(){ return episodeById(store.activeId); }

  /* ======================= transcript index ======================= */

  function parseTime(str){
    var p = String(str).split(":").map(Number);
    if(p.some(isNaN)) return null;
    if(p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if(p.length === 2) return p[0] * 60 + p[1];
    return null;
  }

  function fmtTime(sec){
    if(sec === null || sec === undefined) return "";
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (h && m < 10 ? "0" : "") + m;
    return (h ? h + ":" : "") + mm + ":" + (s < 10 ? "0" : "") + s;
  }

  var TIME_LEAD = /^\s*[\[\(]?(\d{1,2}:\d{2}(?::\d{2})?)[\]\)]?\s*/;
  var SPEAKER = /^\s*[A-Z][\w .'’-]{0,28}:\s+/;

  var VTT_CUE = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/;

  /* Raw WebVTT, straight from a caption file. YouTube repeats the previous line
     in each following cue and wraps words in timing tags — both are stripped. */
  function parseVTT(raw){
    var out = [], t = null;
    String(raw).replace(/\r/g, "").split("\n").forEach(function(line){
      line = line.trim();
      if(!line || line === "WEBVTT") return;
      if(/^(Kind|Language|NOTE|STYLE|REGION)\b/.test(line)) return;

      var m = line.match(VTT_CUE);
      if(m){
        t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
        return;
      }
      if(/^\d+$/.test(line)) return;              // cue number
      if(t === null) return;

      var text = line.replace(/<[^>]+>/g, "")
                     .replace(/&nbsp;/g, " ")
                     .replace(/&amp;/g, "&")
                     .replace(/&#39;|&apos;/g, "'")
                     .replace(/&quot;/g, '"')
                     .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                     .replace(/\s+/g, " ")
                     .trim();
      if(!text) return;
      if(out.length && out[out.length - 1].text === text) return;   // rolling duplicate
      out.push({ text: text, t: Math.round(t) });
    });
    return out;
  }

  /* Turn raw transcript text into timestamped sentences plus a vocabulary. */
  function buildIndex(raw){
    var src = String(raw || "");

    if(/^\s*WEBVTT/.test(src) || VTT_CUE.test(src)){
      var cues = parseVTT(src);
      if(cues.length) return finishIndex(groupChunks(cues));
    }

    var lines = src.replace(/\r/g, "").split("\n");
    var chunks = [], lastT = null;

    lines.forEach(function(line){
      var t = null;
      var m = line.match(TIME_LEAD);
      if(m){ t = parseTime(m[1]); line = line.slice(m[0].length); }
      // YouTube puts the timestamp on its own line, so remember it even when
      // nothing else is on that line — the next line is what it belongs to.
      if(t !== null) lastT = t;
      line = line.replace(/[\[\(]\d{1,2}:\d{2}(?::\d{2})?[\]\)]/g, " ")
                 .replace(SPEAKER, " ")
                 .replace(/\s+/g, " ")
                 .trim();
      if(!line) return;
      chunks.push({ text: line, t: lastT });
    });

    /* YouTube's automatic captions arrive as short unpunctuated lines. Without
       sentence endings there is nothing to split on, so group the lines instead
       and keep the timestamp of the line each group starts at. */
    var punct = chunks.filter(function(c){ return /[.!?]/.test(c.text); }).length;
    if(chunks.length >= 2 && punct < chunks.length * 0.15){
      return finishIndex(groupChunks(chunks));
    }

    // Join chunks into sentences, keeping the timestamp of where each began.
    var sentences = [], buf = "", bufT = null;
    chunks.forEach(function(c){
      if(!buf) bufT = c.t;
      buf = (buf ? buf + " " : "") + c.text;
      var parts = buf.match(/[^.!?]+[.!?]+/g);
      if(parts){
        parts.forEach(function(p){
          var s = p.trim();
          if(s.length > 1) sentences.push({ text: s, t: bufT });
        });
        var consumed = parts.join("").length;
        buf = buf.slice(consumed).trim();
        bufT = c.t;
      }
    });
    if(buf.trim().length > 1) sentences.push({ text: buf.trim(), t: bufT });

    /* A transcript with punctuation can still be one endless paragraph.
       Anything much longer than a sentence gets grouped the same way. */
    var tooLong = sentences.filter(function(s){ return s.text.length > 600; }).length;
    if(sentences.length && tooLong / sentences.length > 0.5){
      return finishIndex(groupChunks(chunks));
    }

    return finishIndex(sentences);
  }

  /* Merge short caption lines into readable ~20-word passages. */
  function groupChunks(chunks){
    var out = [], buf = [], bufT = null, words = 0;
    chunks.forEach(function(c){
      if(!buf.length) bufT = c.t;
      buf.push(c.text);
      words += c.text.split(/\s+/).length;
      if(words >= 20){
        out.push({ text: buf.join(" ").trim(), t: bufT });
        buf = []; words = 0; bufT = null;
      }
    });
    if(buf.length) out.push({ text: buf.join(" ").trim(), t: bufT });
    return out;
  }

  function finishIndex(sentences){
    var vocab = {};
    var all = sentences.map(function(s){ return s.text; }).join(" ").toLowerCase();
    (all.match(/[a-z][a-z'’-]{2,}/g) || []).forEach(function(w){ vocab[w] = (vocab[w] || 0) + 1; });
    return {
      sentences: sentences,
      vocab: vocab,
      words: Object.keys(vocab).length,
      timestamps: sentences.filter(function(s){ return s.t !== null; }).length
    };
  }

  function indexFor(ep){
    if(!ep || !ep.transcript) return null;
    if(!indexes[ep.id]) indexes[ep.id] = buildIndex(ep.transcript);
    return indexes[ep.id];
  }

  /* ---- fuzzy repair against the episode's own vocabulary ---- */
  function editDistance(a, b, max){
    if(Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for(j = 0; j <= b.length; j++) prev[j] = j;
    for(i = 1; i <= a.length; i++){
      cur[0] = i;
      var best = i;
      for(j = 1; j <= b.length; j++){
        cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a.charAt(i-1) === b.charAt(j-1) ? 0 : 1));
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
    for(var i = 0; i < idx.sentences.length; i++){
      if(re.test(idx.sentences[i].text)) return idx.sentences[i];
    }
    return null;
  }

  /* Where in the transcript does this snippet of overheard audio sit?
     Token overlap is crude but good enough to place a note. */
  function locate(idx, snippet){
    var words = (String(snippet || "").toLowerCase().match(/[a-z][a-z'’-]{3,}/g) || []);
    if(words.length < 4) return null;
    var want = {};
    words.forEach(function(w){ want[w] = 1; });

    var best = null, bestScore = 0;
    idx.sentences.forEach(function(s){
      var toks = (s.text.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) || []);
      if(!toks.length) return;
      var hits = 0;
      toks.forEach(function(t){ if(want[t]) hits++; });
      var score = hits / Math.sqrt(toks.length);
      if(score > bestScore){ bestScore = score; best = s; }
    });
    return bestScore >= 1.2 ? best : null;
  }

  /* Resolve a heard word against the active episode. */
  function resolveWord(word){
    var ep = activeEpisode(), idx = indexFor(ep);
    if(!idx) return { word: word, sentence: "", t: null, matched: false };

    var hit = findInIndex(idx, word), used = word, repaired = false;
    if(!hit){
      var alt = nearestInVocab(idx.vocab, word);
      if(alt && alt !== word){
        hit = findInIndex(idx, alt);
        if(hit){ used = alt; repaired = true; }
      }
    }
    if(!hit) return { word: word, sentence: "", t: null, matched: false };
    return { word: used, sentence: clipAround(hit.text, used), t: hit.t, matched: true, repaired: repaired };
  }

  function clipAround(s, word){
    if(s.length <= 260) return s;
    var i = s.toLowerCase().indexOf(String(word).toLowerCase());
    if(i === -1) return s.slice(0, 257).trim() + "…";
    var start = Math.max(0, i - 110), end = Math.min(s.length, i + 150);
    return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
  }

  /* ============================ entries ============================ */

  function cleanWord(w){
    return String(w || "").toLowerCase().replace(/[^a-z'’\- ]/g, "").trim();
  }

  function pickDef(d){
    return {
      meaning: String(d.meaning || d.definition || "").trim(),
      example: String(d.example || "").trim(),
      ipa: String(d.ipa || d.pronunciation || "").trim(),
      pos: String(d.pos || d.partOfSpeech || "").trim()
    };
  }

  function applySeed(){
    var n = 0;
    store.entries.forEach(function(e){
      if(e.kind !== "note" && !e.meaning && SEED[e.word]){
        Object.assign(e, pickDef(SEED[e.word]));
        e.updatedAt = Date.now();
        n++;
      }
    });
    return n;
  }

  function addWord(word, spokenSentence, source){
    var w = cleanWord(word);
    if(w.length < 2) return null;

    var now = Date.now();
    var dupe = store.entries.filter(function(e){
      return e.kind !== "note" && e.word === w && e.episodeId === store.activeId;
    })[0];
    if(dupe && now - (dupe.createdAt || 0) < 60000) return null;

    var res = resolveWord(w);
    var entry = {
      id: newId("w"),
      kind: "word",
      episodeId: store.activeId,
      word: res.matched ? res.word : w,
      heardAs: res.repaired ? w : "",
      sentence: res.matched ? res.sentence : String(spokenSentence || "").trim(),
      t: res.t,
      via: res.matched ? "transcript" : "",
      source: source || "voice",
      createdAt: now,
      updatedAt: now,
      meaning: "", example: "", ipa: "", pos: ""
    };
    if(SEED[entry.word]) Object.assign(entry, pickDef(SEED[entry.word]));

    store.entries.unshift(entry);
    save();
    render();
    return entry;
  }

  function addNote(text, source){
    var body = String(text || "").trim();
    if(body.length < 2) return null;

    var now = Date.now();
    var ep = activeEpisode(), idx = indexFor(ep);
    var passage = null;
    if(idx && source === "voice") passage = locate(idx, contextBefore(now));

    var entry = {
      id: newId("n"),
      kind: "note",
      episodeId: store.activeId,
      text: body,
      passage: passage ? passage.text : "",
      t: passage ? passage.t : null,
      source: source || "voice",
      createdAt: now,
      updatedAt: now
    };
    store.entries.unshift(entry);
    save();
    render();
    return entry;
  }

  function removeEntry(id){
    store.entries = store.entries.filter(function(e){ return e.id !== id; });
    save(); render();
  }

  /* ============================ rendering ============================ */

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

  /* Build a deep link into the source at a given second, when we can. */
  function jumpLink(ep, t){
    if(!ep || !ep.url || t === null || t === undefined) return "";
    var url = ep.url, sec = Math.max(0, Math.round(t));
    var yt = url.match(/(?:youtube\.com\/watch\?[^#]*\bv=|youtu\.be\/)([\w-]{6,})/);
    if(yt) return "https://www.youtube.com/watch?v=" + yt[1] + "&t=" + sec + "s";
    if(/open\.spotify\.com/.test(url)) return url.split("?")[0] + "?t=" + sec;
    return url + (url.indexOf("#") === -1 ? "#t=" + sec : "");
  }

  function stamp(ep, t){
    if(t === null || t === undefined) return "";
    var link = jumpLink(ep, t);
    var label = fmtTime(t);
    return link
      ? '<a class="stamp" href="' + esc(link) + '" target="_blank" rel="noopener">' + label + "</a>"
      : '<span class="stamp flat">' + label + "</span>";
  }

  function wordCard(e, ep){
    var head = '<div class="head"><span class="word">' + esc(e.word) + "</span>" +
      (e.ipa ? '<span class="ipa">' + esc(e.ipa) + "</span>" : "") +
      (e.pos ? '<span class="pos">' + esc(e.pos) + "</span>"
             : (e.meaning ? "" : '<span class="pending">meaning pending</span>')) +
      "</div>";
    var heard = e.heardAs ? '<p class="repair">heard as &ldquo;' + esc(e.heardAs) + '&rdquo;</p>' : "";
    var meaning = e.meaning ? '<p class="meaning">' + esc(e.meaning) + "</p>" : "";
    var quote = e.sentence ? '<p class="quote">&ldquo;' + esc(e.sentence) + "&rdquo;</p>" : "";
    var example = e.example ? '<p class="example">' + esc(e.example) + "</p>" : "";
    var foot = '<div class="foot">' + stamp(ep, e.t) + "<span>" + when(e.createdAt) + "</span>" +
      "<span>" + (e.via === "transcript" ? "transcript" : e.source === "voice" ? "voice" : "typed") + "</span>" +
      '<span class="spacer"></span>' +
      '<button type="button" data-edit="' + e.id + '">Edit</button>' +
      '<button type="button" class="del" data-del="' + e.id + '">Delete</button></div>';
    return '<article class="card">' + head + heard + meaning + quote + example + foot + "</article>";
  }

  function noteCard(e, ep){
    var body = '<p class="note-text">' + esc(e.text) + "</p>";
    var passage = e.passage ? '<p class="quote">&ldquo;' + esc(e.passage) + "&rdquo;</p>" : "";
    var foot = '<div class="foot">' + stamp(ep, e.t) + "<span>" + when(e.createdAt) + "</span>" +
      '<span class="spacer"></span>' +
      '<button type="button" data-edit="' + e.id + '">Edit</button>' +
      '<button type="button" class="del" data-del="' + e.id + '">Delete</button></div>';
    return '<article class="card note"><div class="head"><span class="kind">note</span></div>' +
      body + passage + foot + "</article>";
  }

  function visibleEntries(){
    return store.entries.filter(function(e){
      var isNote = e.kind === "note";
      if(filter === "word" && isNote) return false;
      if(filter === "note" && !isNote) return false;
      if(filter === "pending" && (isNote || e.meaning)) return false;
      if(scopeEpisode && e.episodeId !== store.activeId) return false;
      if(query){
        var hay = ((isNote ? e.text + " " + e.passage : e.word + " " + e.sentence + " " + e.meaning) || "").toLowerCase();
        if(hay.indexOf(query) === -1) return false;
      }
      return true;
    });
  }

  function render(){
    var list = $("#list");
    if(!list) return;
    var shown = visibleEntries();
    var words = store.entries.filter(function(e){ return e.kind !== "note"; });

    $("#c-total").textContent = store.entries.length;
    $("#c-pending").textContent = words.filter(function(e){ return !e.meaning; }).length;
    renderEpisodeStrip();

    if(!shown.length){
      list.innerHTML = '<div class="empty"><strong>' +
        (store.entries.length ? "Nothing matches that filter." : "Nothing caught yet.") + "</strong>" +
        (store.entries.length ? "Try another filter or clear the search."
          : "Pick the episode you&rsquo;re about to listen to, paste its transcript, then tap <em>Start listening</em>. Say &ldquo;save&rdquo; and a word, or &ldquo;note that&rdquo; and a thought.") +
        "</div>";
      return;
    }

    var html = "", lastEp = "__none__";
    var grouped = !scopeEpisode;
    shown.forEach(function(e){
      if(grouped && e.episodeId !== lastEp){
        lastEp = e.episodeId;
        var ep = episodeById(e.episodeId);
        html += '<h3 class="group">' + esc(ep ? ep.title : "Unfiled") + "</h3>";
      }
      var ep2 = episodeById(e.episodeId);
      html += e.kind === "note" ? noteCard(e, ep2) : wordCard(e, ep2);
    });
    list.innerHTML = html;
  }

  function renderEpisodeStrip(){
    var ep = activeEpisode();
    var idx = indexFor(ep);
    if(!$("#ep-title") || !$("#ep-meta")) return;
    $("#ep-title").textContent = ep ? ep.title : "Nothing chosen";
    var meta = $("#ep-meta");
    if(!ep){
      meta.textContent = "Load a transcript first and every word comes back spelled right";
      meta.className = "ep-meta";
    }else if(idx){
      meta.textContent = idx.sentences.length + " sentences · " + idx.words + " distinct words" +
        (idx.timestamps ? " · timestamps" : " · no timestamps");
      meta.className = "ep-meta good";
    }else{
      meta.textContent = "No transcript — words will be saved as heard";
      meta.className = "ep-meta warn";
    }
  }

  /* ============================ toast ============================ */

  var toastTimer = null;
  function toast(msg){
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    $("#live-region").textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 2400);
  }
  function notice(msg, warn){
    if(!$("#notice-slot")) return;
    $("#notice-slot").innerHTML = '<div class="notice' + (warn ? " warn" : "") + '">' + msg + "</div>";
  }

  /* ============================ speech ============================ */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, wantListening = false, restartTimer = null;
  var heard = [];
  var WORD_TRIGGERS = ["save", "catch"];
  var NOTE_TRIGGERS = ["note that", "note this", "remember that", "make a note"];
  var STOP = {"the":1,"a":1,"an":1,"it":1,"this":1,"that":1,"word":1,"and":1,"is":1,"to":1};

  var logLines = [];
  function logLine(msg){
    var d = new Date();
    var st = ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    logLines.push(st + "  " + msg);
    if(logLines.length > 60) logLines.shift();
    var el = document.getElementById("diag-log");
    if(el && el.dataset.live === "1"){ el.textContent = logLines.join("\n"); el.scrollTop = el.scrollHeight; }
  }

  function ribbon(text, live){
    var el = $("#ribbon-text");
    el.innerHTML = "<bdi>" + esc(text || "Nothing yet.") + "</bdi>";
    el.style.color = live ? "var(--ink)" : "";
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

  function lastTriggerIndex(lower, triggers){
    var best = -1, used = "";
    triggers.forEach(function(t){
      var idx = lower.lastIndexOf(" " + t + " ");
      if(idx > best){ best = idx; used = t; }
    });
    return { at: best, trigger: used };
  }

  function handleFinal(text){
    var now = Date.now();
    var clean = text.trim();
    if(!clean) return;
    ribbon(clean, false);

    var lower = " " + clean.toLowerCase() + " ";

    // Notes win over words: "note that ..." is longer and more specific.
    var noteHit = lastTriggerIndex(lower, NOTE_TRIGGERS);
    if(noteHit.at !== -1){
      var body = clean.slice(noteHit.at + noteHit.trigger.length + 1).trim();
      if(body.length > 1){
        var note = addNote(body, "voice");
        if(note){
          toast("Note saved");
          if(navigator.vibrate) try{ navigator.vibrate(35); }catch(e){}
        }
        return;
      }
    }

    var wordHit = lastTriggerIndex(lower, WORD_TRIGGERS);
    if(wordHit.at === -1){
      heard.push({ text: clean, t: now });
      if(heard.length > 60) heard.shift();
      return;
    }

    var rest = clean.slice(wordHit.at + wordHit.trigger.length + 1).trim();
    rest = rest.replace(/^(the\s+word\s+|word\s+)/i, "").trim();
    var tokens = rest.split(/\s+/).filter(Boolean);
    if(!tokens.length) return;

    var word = tokens[0];
    if(STOP[cleanWord(word)] && tokens.length > 1){ tokens.shift(); word = tokens[0]; }
    var spoken = tokens.slice(1).join(" ").trim();
    if(!spoken) spoken = contextBefore(now);

    var added = addWord(word, spoken, "voice");
    if(added){
      toast(added.heardAs ? "Caught “" + added.word + "” (heard “" + added.heardAs + "”)"
                          : "Caught “" + added.word + "”");
      if(navigator.vibrate) try{ navigator.vibrate(35); }catch(e){}
    }
  }

  function buildRecognizer(){
    var r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onstart = function(){ logLine("recognition started"); };
    r.onaudiostart = function(){ logLine("microphone open (audio flowing)"); };
    r.onspeechstart = function(){ logLine("speech detected"); };
    r.onnomatch = function(){ logLine("heard speech but recognized nothing"); };
    r.onresult = function(ev){
      var interim = "";
      for(var i = ev.resultIndex; i < ev.results.length; i++){
        var res = ev.results[i];
        if(res.isFinal) handleFinal(res[0].transcript);
        else interim += res[0].transcript;
      }
      if(interim) ribbon(interim, true);
    };
    r.onerror = function(ev){
      logLine("ERROR: " + (ev.error || "unknown") + (ev.message ? " — " + ev.message : ""));
      if(ev.error === "not-allowed" || ev.error === "service-not-allowed"){
        wantListening = false; setMic(false);
        notice("The browser refused the microphone (<code>" + esc(ev.error) + "</code>). Run the microphone check at the bottom of this page.", true);
      }else if(ev.error === "network"){
        notice("Speech recognition could not reach its service. Check your connection — it will keep retrying.", true);
      }else if(ev.error !== "no-speech" && ev.error !== "aborted"){
        notice("Speech recognition stopped: <code>" + esc(ev.error || "unknown") + "</code>.", true);
      }
    };
    r.onend = function(){
      logLine("recognition ended" + (wantListening ? " — restarting" : ""));
      if(wantListening){
        clearTimeout(restartTimer);
        restartTimer = setTimeout(function(){ try{ r.start(); }catch(e){} }, 350);
      }else setMic(false);
    };
    return r;
  }

  function setMic(on){
    var b = $("#mic");
    b.setAttribute("aria-pressed", on ? "true" : "false");
    $("#mic-title").textContent = on ? "Listening" : "Start listening";
    $("#mic-sub").textContent = on
      ? "“save” + a word · “note that” + a thought"
      : "Say “save” + a word, or “note that” + a thought";
  }

  var wakeLock = null;
  async function holdScreen(){
    try{ if(navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); }catch(e){}
  }
  function releaseScreen(){
    try{ if(wakeLock){ wakeLock.release(); wakeLock = null; } }catch(e){}
  }
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState === "visible" && wantListening){
      wakeLock = null; holdScreen();
      clearTimeout(restartTimer);
      restartTimer = setTimeout(function(){ if(rec) try{ rec.start(); }catch(e){} }, 300);
    }
  });

  function startListening(){
    if(!SR) return;
    if(!rec) rec = buildRecognizer();
    wantListening = true;
    setMic(true);
    logLine("start requested by tap");
    try{ rec.start(); }
    catch(e){ logLine("start() threw: " + (e && (e.name + " " + e.message))); }
    holdScreen();
    if(!activeEpisode()){
      notice("No episode chosen — words will be saved exactly as the microphone hears them. Tap <strong>Change</strong> above to add one with its transcript.");
    }else{
      notice("Keep this page in front while you listen. The microphone only works while it is the visible page.");
    }
  }
  function stopListening(){
    wantListening = false;
    clearTimeout(restartTimer);
    if(rec) try{ rec.stop(); }catch(e){}
    releaseScreen();
    setMic(false);
  }

  on("#mic", "click", function(){
    if(!SR){
      notice("This browser cannot listen. Chrome on Android or Safari on iOS work — or tap <strong>Type</strong> to add things by hand.", true);
      return;
    }
    if(wantListening) stopListening(); else startListening();
  });

  /* ============================ episodes ============================ */

  var editingId = null;        // episode being edited, or null when creating one

  function setActive(id){
    store.activeId = id;
    save();
    render();
  }

  function renderEpisodeList(){
    var el = $("#ep-list");
    if(!el) return;
    if(!store.episodes.length){ el.innerHTML = ""; return; }

    var rows = store.episodes.slice()
      .sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); })
      .map(function(ep){
        var idx = indexFor(ep);
        var count = store.entries.filter(function(e){ return e.episodeId === ep.id; }).length;
        return '<div class="ep-row' + (ep.id === store.activeId ? " on" : "") +
                 (ep.id === editingId ? " editing" : "") + '">' +
          '<button type="button" class="ep-pick" data-ep="' + esc(ep.id) + '">' +
            '<span class="ep-row-title">' + esc(ep.title) + "</span>" +
            '<span class="ep-row-meta">' + count + (count === 1 ? " item" : " items") +
              (idx ? " · " + idx.sentences.length + " sentences" : " · no transcript") +
              (ep.id === store.activeId ? " · listening" : "") + "</span>" +
          "</button>" +
          '<button type="button" class="ep-edit" data-edit-ep="' + esc(ep.id) + '" ' +
            'aria-label="Edit ' + esc(ep.title) + '">Edit</button>' +
        "</div>";
      }).join("");
    el.innerHTML = '<div class="cue">episodes</div>' + rows;
  }

  function resetEpisodeForm(keepResult){
    editingId = null;
    var name = $("#ep-name"), url = $("#ep-url"), tr = $("#ep-transcript");
    if(name) name.value = "";
    if(url) url.value = "";
    if(tr) tr.value = "";
    if($("#ep-form-title")) $("#ep-form-title").textContent = "new episode";
    if($("#ep-submit")) $("#ep-submit").textContent = "Start this episode";
    if($("#ep-actions")) $("#ep-actions").hidden = true;
    if($("#ep-new")) $("#ep-new").hidden = true;
    if($("#ep-result") && !keepResult) $("#ep-result").hidden = true;
    renderEpisodeList();
  }

  function editEpisode(id){
    var ep = episodeById(id);
    if(!ep) return;
    editingId = id;
    $("#ep-name").value = ep.title || "";
    $("#ep-url").value = ep.url || "";
    $("#ep-transcript").value = ep.transcript || "";
    $("#ep-form-title").textContent = "editing";
    $("#ep-submit").textContent = ep.id === store.activeId ? "Save changes" : "Save & listen to this";
    $("#ep-actions").hidden = false;
    $("#ep-new").hidden = false;
    $("#ep-result").hidden = true;
    $("#ep-panel").classList.add("open");
    renderEpisodeList();
    $("#ep-name").focus();
  }

  on("#ep-toggle", "click", function(){
    var p = $("#ep-panel");
    p.classList.toggle("open");
    if(p.classList.contains("open")){
      renderEpisodeList();
      if(!editingId) $("#ep-name").focus();
    }
  });

  on("#ep-cancel", "click", function(){
    $("#ep-panel").classList.remove("open");
    resetEpisodeForm();
  });

  on("#ep-new", "click", function(){
    resetEpisodeForm();
    $("#ep-name").focus();
  });

  on("#ep-list", "click", function(ev){
    var edit = ev.target.closest("[data-edit-ep]");
    if(edit){ editEpisode(edit.dataset.editEp); return; }

    var pick = ev.target.closest("[data-ep]");
    if(!pick) return;
    setActive(pick.dataset.ep);
    $("#ep-panel").classList.remove("open");
    resetEpisodeForm();
    toast("Now on “" + (activeEpisode() || {}).title + "”");
  });

  on("#ep-delete", "click", function(){
    var ep = episodeById(editingId) || activeEpisode();
    if(!ep) return;
    var mine = store.entries.filter(function(e){ return e.episodeId === ep.id; });
    var msg = mine.length
      ? "Delete “" + ep.title + "” and the " + mine.length + " " +
        (mine.length === 1 ? "item" : "items") + " caught in it?\n\nThis cannot be undone."
      : "Delete “" + ep.title + "”?";
    if(!window.confirm(msg)) return;

    store.entries = store.entries.filter(function(e){ return e.episodeId !== ep.id; });
    store.episodes = store.episodes.filter(function(e){ return e.id !== ep.id; });
    delete indexes[ep.id];
    if(store.activeId === ep.id) store.activeId = store.episodes.length ? store.episodes[0].id : null;
    save(); render();
    resetEpisodeForm();
    toast("Deleted “" + ep.title + "”");
  });

  on("#ep-paste", "click", async function(){
    var out = $("#ep-result");
    out.hidden = false;
    try{
      var text = await navigator.clipboard.readText();
      if(!text || text.trim().length < 40){
        out.textContent = "Nothing that looks like a transcript is on the clipboard.";
        return;
      }
      $("#ep-transcript").value = text;
      out.innerHTML = "Pasted <b>" + text.trim().split(/\s+/).length.toLocaleString() +
        "</b> words — tap <b>" + $("#ep-submit").textContent + "</b>.";
    }catch(e){
      out.textContent = "This browser would not hand over the clipboard — long-press the box and paste instead.";
    }
  });

  on("#ep-form", "submit", function(ev){
    ev.preventDefault();
    var title = $("#ep-name").value.trim();
    var url = $("#ep-url").value.trim();
    var transcript = $("#ep-transcript").value.trim();
    var out = $("#ep-result");

    if(!title && !url){
      out.hidden = false;
      out.textContent = "Give it a title so you can find it later.";
      return;
    }

    var ep = episodeById(editingId);
    var isNew = !ep;
    if(isNew){
      ep = { id: newId("ep"), createdAt: Date.now() };
      store.episodes.unshift(ep);
    }

    var transcriptChanged = (ep.transcript || "") !== transcript;
    ep.title = title || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60);
    ep.url = url;
    ep.transcript = transcript;
    ep.updatedAt = Date.now();
    delete indexes[ep.id];

    setActive(ep.id);
    var idx = indexFor(ep);

    out.hidden = false;
    if(!isNew && transcriptChanged && transcript){
      rematch(ep, out);                  // fills in sentences for words already caught
      resetEpisodeForm(true);
      toast("Episode updated");
      return;
    }
    out.innerHTML = idx
      ? (isNew ? "Ready — <b>" : "Saved — <b>") + idx.sentences.length + "</b> sentences indexed" +
        (idx.timestamps ? ", timestamps found." : ", no timestamps in this one.")
      : (isNew ? "Episode saved. " : "Saved. ") + "Without a transcript, words are stored exactly as heard.";

    var name = ep.title;
    resetEpisodeForm(true);
    renderEpisodeList();
    // Creating an episode means you are about to listen — get out of the way.
    // Editing one means you want to see what changed, so the panel stays.
    if(isNew) $("#ep-panel").classList.remove("open");
    toast(isNew ? "Now on “" + name + "”" : "Saved “" + name + "”");
  });

  /* ============================ hand entry ============================ */

  function setHandKind(kind){
    handKind = kind;
    document.querySelectorAll(".seg-btn").forEach(function(b){
      b.setAttribute("aria-pressed", b.dataset.kind === kind ? "true" : "false");
    });
    $("#hand-word").hidden = kind === "note";
    $("#hand-sentence").placeholder = kind === "note"
      ? "What you want to remember"
      : "The sentence you heard (optional)";
    $("#hand-submit").textContent = kind === "note" ? "Add note" : "Add word";
  }

  document.querySelectorAll(".seg-btn").forEach(function(b){
    b.addEventListener("click", function(){ setHandKind(b.dataset.kind); });
  });

  on("#toggle-hand", "click", function(){
    var h = $("#hand");
    h.classList.toggle("open");
    if(h.classList.contains("open")) (handKind === "note" ? $("#hand-sentence") : $("#hand-word")).focus();
  });
  on("#hand-cancel", "click", function(){ $("#hand").classList.remove("open"); });

  on("#hand", "submit", function(ev){
    ev.preventDefault();
    if(handKind === "note"){
      var note = addNote($("#hand-sentence").value, "typed");
      if(note){ toast("Note added"); $("#hand-sentence").value = ""; }
      else toast("Write the note first");
      return;
    }
    var added = addWord($("#hand-word").value, $("#hand-sentence").value, "typed");
    if(added){
      toast("Added “" + added.word + "”");
      $("#hand-word").value = ""; $("#hand-sentence").value = "";
      $("#hand-word").focus();
    }else toast("Type a word first");
  });

  /* ============================ filters ============================ */

  document.querySelectorAll(".bar .chip[data-filter]").forEach(function(c){
    c.addEventListener("click", function(){
      filter = c.dataset.filter;
      document.querySelectorAll(".bar .chip[data-filter]").forEach(function(o){
        o.setAttribute("aria-pressed", o === c ? "true" : "false");
      });
      render();
    });
  });

  on("#scope-toggle", "click", function(){
    scopeEpisode = !scopeEpisode;
    $("#scope-toggle").setAttribute("aria-pressed", scopeEpisode ? "true" : "false");
    render();
  });

  on("#search", "input", function(e){
    query = e.target.value.trim().toLowerCase();
    render();
  });

  on("#list", "click", function(ev){
    var del = ev.target.closest("[data-del]");
    if(del){
      removeEntry(del.dataset.del);
      toast("Deleted");
      return;
    }
    var ed = ev.target.closest("[data-edit]");
    if(ed){
      var e = store.entries.filter(function(x){ return x.id === ed.dataset.edit; })[0];
      if(!e) return;
      if(e.kind === "note"){
        var nt = window.prompt("Note:", e.text || "");
        if(nt === null) return;
        e.text = nt.trim();
      }else{
        var st = window.prompt("The sentence you heard “" + e.word + "” in:", e.sentence || "");
        if(st === null) return;
        e.sentence = st.trim();
      }
      e.updatedAt = Date.now();
      save(); render();
    }
  });

  /* ============================ clipboard ============================ */

  function copy(text, okMsg){
    var done = function(){ toast(okMsg); };
    function fallback(){
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand("copy"); done(); }catch(e){ toast("Could not copy"); }
      document.body.removeChild(ta);
    }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, fallback);
    }else fallback();
  }

  on("#copy-words", "click", function(){
    var pending = store.entries.filter(function(e){ return e.kind !== "note" && !e.meaning; });
    if(!pending.length){ toast("Every word already has a meaning"); return; }
    var payload = pending.map(function(e){ return {word:e.word, heard_in:e.sentence}; });
    var text = "These are English words I heard but did not know. For each one give a short plain-English meaning " +
      "(one or two sentences, matching how it is used in the sentence I heard), the IPA pronunciation, the part of speech, " +
      "and one fresh example sentence.\n\nReply with ONLY a JSON array like " +
      '[{"word":"","pos":"","ipa":"","meaning":"","example":""}] and nothing else.\n\n' +
      JSON.stringify(payload, null, 2);
    copy(text, "Copied — paste it into Claude");
  });

  on("#toggle-paste", "click", function(){
    var p = $("#paste");
    p.classList.toggle("open");
    if(p.classList.contains("open")) $("#paste-box").focus();
  });

  on("#paste-apply", "click", function(){
    var raw = $("#paste-box").value.trim();
    if(!raw){ toast("Paste Claude’s reply first"); return; }
    var start = raw.indexOf("["), end = raw.lastIndexOf("]");
    if(start === -1 || end === -1){ toast("That does not look like the JSON list"); return; }
    var data;
    try{ data = JSON.parse(raw.slice(start, end + 1)); }
    catch(e){ toast("Could not read that JSON"); return; }
    if(!Array.isArray(data)){ toast("Expected a list of words"); return; }

    var applied = 0;
    data.forEach(function(d){
      var w = cleanWord(d && d.word);
      if(!w) return;
      var def = pickDef(d);
      store.entries.forEach(function(e){
        if(e.kind !== "note" && e.word === w && (!e.meaning || def.meaning)){
          Object.assign(e, def); e.updatedAt = Date.now(); applied++;
        }
      });
    });
    if(applied){
      save(); render();
      $("#paste-box").value = "";
      $("#paste").classList.remove("open");
      toast(applied + (applied === 1 ? " meaning added" : " meanings added"));
    }else toast("None of those words are in your list");
  });

  on("#export", "click", function(){
    if(!store.entries.length){ toast("Nothing to copy yet"); return; }
    var byEp = {};
    store.entries.forEach(function(e){
      (byEp[e.episodeId] = byEp[e.episodeId] || []).push(e);
    });
    var text = Object.keys(byEp).map(function(id){
      var ep = episodeById(id);
      var head = (ep ? ep.title : "Unfiled") + (ep && ep.url ? "\n" + ep.url : "");
      var items = byEp[id].map(function(e){
        var ts = e.t !== null && e.t !== undefined ? "[" + fmtTime(e.t) + "] " : "";
        if(e.kind === "note"){
          return ts + "NOTE: " + e.text + (e.passage ? "\n    while hearing: “" + e.passage + "”" : "");
        }
        return ts + e.word +
          (e.pos ? " (" + e.pos + ")" : "") + (e.ipa ? " " + e.ipa : "") +
          (e.meaning ? "\n    " + e.meaning : "\n    [meaning pending]") +
          (e.sentence ? "\n    heard: “" + e.sentence + "”" : "");
      }).join("\n\n");
      return head + "\n" + "-".repeat(Math.min(60, head.split("\n")[0].length)) + "\n" + items;
    }).join("\n\n\n");
    copy(text, "Whole list copied");
  });

  /* ==================== transcript for this episode ==================== */

  function rematch(epArg, outArg){
    var ep = epArg || activeEpisode();
    var out = outArg || $("#transcript-result");
    if(!out) return;
    out.hidden = false;
    if(!ep){ out.textContent = "Choose an episode first."; return; }
    var idx = indexFor(ep);
    if(!idx){ out.textContent = "This episode has no transcript yet — paste one above."; return; }

    var matched = 0, repaired = 0, missed = [], placed = 0;
    store.entries.forEach(function(e){
      if(e.episodeId !== ep.id) return;

      if(e.kind === "note"){
        if(!e.passage && e.sentenceHint){
          var loc = locate(idx, e.sentenceHint);
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
        e.word = used;
        e.sentence = clipAround(hit.text, used);
        e.t = hit.t;
        e.via = "transcript";
        e.updatedAt = Date.now();
        matched++;
      }else missed.push(e.word);
    });

    save(); render();
    out.innerHTML = "<b>" + matched + "</b> " + (matched === 1 ? "word" : "words") + " matched" +
      (repaired ? ", <b>" + repaired + "</b> " + (repaired === 1 ? "spelling fixed" : "spellings fixed") : "") +
      (placed ? ", <b>" + placed + "</b> " + (placed === 1 ? "note placed" : "notes placed") : "") + "." +
      (missed.length ? " Not in this transcript: <span class=\"miss\">" + esc(missed.slice(0, 12).join(", ")) +
        (missed.length > 12 ? " +" + (missed.length - 12) + " more" : "") + "</span>" : "");
    if(matched) toast(matched + (matched === 1 ? " sentence updated" : " sentences updated"));
  }

  on("#toggle-transcript", "click", function(){
    var t = $("#transcript");
    t.classList.toggle("open");
    if(t.classList.contains("open")){
      var ep = activeEpisode();
      $("#transcript-box").value = ep ? (ep.transcript || "") : "";
      $("#transcript-box").focus();
    }
  });

  on("#transcript-apply", "click", function(){
    var ep = activeEpisode();
    var out = $("#transcript-result");
    out.hidden = false;
    if(!ep){ out.textContent = "Choose an episode first — tap Change at the top."; return; }
    var text = $("#transcript-box").value.trim();
    if(text.length < 40){ out.textContent = "That looks too short to be a transcript."; return; }
    ep.transcript = text;
    ep.updatedAt = Date.now();
    delete indexes[ep.id];
    indexFor(ep);
    save();
    rematch();
  });

  on("#transcript-paste", "click", async function(){
    var out = $("#transcript-result");
    try{
      var text = await navigator.clipboard.readText();
      if(!text || text.trim().length < 40){
        out.hidden = false;
        out.textContent = "Nothing that looks like a transcript is on the clipboard.";
        return;
      }
      $("#transcript-box").value = text;
      out.hidden = false;
      out.innerHTML = "Pasted <b>" + text.trim().split(/\s+/).length.toLocaleString() +
        "</b> words — tap <b>Save transcript &amp; match</b>.";
    }catch(e){
      out.hidden = false;
      out.textContent = "This browser would not hand over the clipboard — long-press the box and paste instead.";
    }
  });

  on("#rematch", "click", function(){
    $("#transcript").classList.add("open");
    rematch();
  });

  /* ============================ batch import ============================ */

  on("#toggle-batch", "click", function(){
    var el = $("#batch");
    el.classList.toggle("open");
    if(el.classList.contains("open")) $("#batch-box").focus();
  });

  on("#batch-apply", "click", function(){
    var out = $("#batch-result");
    var lines = $("#batch-box").value.split(/[\n\r;]+/);
    var added = 0, skipped = 0;
    lines.forEach(function(line){
      var raw = line.trim();
      if(!raw) return;
      raw = raw.replace(/^[-*•\d.)\s]+/, "").trim();
      var parts = raw.split(/\s+[—–-]\s+|\s*[:|\t]\s*/);
      var word = parts.shift();
      var sentence = parts.join(" ").trim();
      var w = cleanWord(word);
      var already = store.entries.filter(function(e){
        return e.kind !== "note" && e.word === w && e.episodeId === store.activeId;
      }).length;
      if(already){ skipped++; return; }
      if(addWord(word, sentence, "typed")) added++; else skipped++;
    });
    out.hidden = false;
    out.innerHTML = "<b>" + added + "</b> " + (added === 1 ? "word added" : "words added") +
      (skipped ? ", " + skipped + " skipped (already here, or too short)" : "") + ".";
    if(added){ $("#batch-box").value = ""; toast(added + (added === 1 ? " word added" : " words added")); }
  });

  /* ============================ backup ============================ */

  function backup(){
    var payload = JSON.stringify({app:"earshot", v:2, exportedAt:new Date().toISOString(),
      episodes:store.episodes, entries:store.entries}, null, 2);
    var blob = new Blob([payload], {type:"application/json"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "earshot-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
    toast("Backup downloaded");
  }

  function restore(file){
    var out = $("#data-result");
    var reader = new FileReader();
    reader.onload = function(){
      var data;
      try{ data = JSON.parse(reader.result); }
      catch(e){ out.hidden = false; out.textContent = "That file is not a valid Earshot backup."; return; }

      var incoming = Array.isArray(data) ? data : (data.entries || []);
      if(!incoming.length){ out.hidden = false; out.textContent = "No words found in that file."; return; }

      var before = store.entries.length;
      var eps = data.episodes || [];
      var known = {};
      store.episodes.forEach(function(e){ known[e.id] = 1; });
      eps.forEach(function(e){ if(e && e.id && !known[e.id]) store.episodes.push(e); });

      if(!eps.length){
        // v1-shaped backup — park it in one episode
        var legacy = episodeById("ep-earlier");
        if(!legacy){
          legacy = { id:"ep-earlier", title:"Earlier words", url:"", transcript:"", createdAt:Date.now(), updatedAt:Date.now() };
          store.episodes.push(legacy);
        }
        incoming.forEach(function(e){ if(!e.episodeId) e.episodeId = legacy.id; e.kind = e.kind || "word"; });
      }

      store.entries = mergeEntries(store.entries, incoming);
      applySeed();
      indexes = {};
      save(); render();
      out.hidden = false;
      out.innerHTML = "Restored — <b>" + (store.entries.length - before) + "</b> new, <b>" +
        store.entries.length + "</b> in total.";
      toast("Backup restored");
    };
    reader.readAsText(file);
  }

  on("#backup", "click", backup);
  on("#restore", "click", function(){ $("#restore-file").click(); });
  on("#restore-file", "change", function(ev){
    if(ev.target.files && ev.target.files[0]) restore(ev.target.files[0]);
    ev.target.value = "";
  });

  /* ============================ diagnostics ============================ */

  function diagHeader(){
    var framed = "unknown";
    try{ framed = (window.self !== window.top) ? "YES — page runs inside a frame" : "no"; }
    catch(e){ framed = "YES — cross-origin frame"; }
    return [
      "EARSHOT MICROPHONE CHECK",
      "user agent: " + navigator.userAgent,
      "page url:   " + location.origin,
      "secure context: " + (window.isSecureContext ? "yes" : "NO — mic is blocked without https"),
      "inside a frame: " + framed,
      "standalone (home screen): " + (navigator.standalone === true ? "yes" : "no"),
      "SpeechRecognition API: " + (window.SpeechRecognition ? "yes (standard)" :
        window.webkitSpeechRecognition ? "yes (webkit)" : "NO — this browser has none"),
      "getUserMedia API: " + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? "yes" : "NO"),
      "----"
    ].join("\n");
  }

  async function runDiag(){
    var el = $("#diag-log");
    el.dataset.live = "1";
    logLines = [];
    var head = diagHeader();
    el.textContent = head + "\nchecking…";
    function paint(){ el.textContent = head + "\n" + logLines.join("\n"); el.scrollTop = el.scrollHeight; }

    try{
      if(navigator.permissions && navigator.permissions.query){
        var st = await navigator.permissions.query({name:"microphone"});
        logLine("permission state: " + st.state);
      }else logLine("permission state: not reported by this browser");
    }catch(e){ logLine("permission state: not reported (" + (e && e.name) + ")"); }
    paint();

    try{
      var stream = await navigator.mediaDevices.getUserMedia({audio:true});
      logLine("getUserMedia: OK — microphone opened");
      var tr = stream.getAudioTracks()[0];
      if(tr) logLine("audio track: " + (tr.label || "unnamed") + ", enabled=" + tr.enabled + ", muted=" + tr.muted);
      stream.getTracks().forEach(function(t){ t.stop(); });
    }catch(e){ logLine("getUserMedia FAILED: " + (e && e.name) + " — " + (e && e.message)); }
    paint();

    if(!SR){ logLine("speech recognition: unavailable, stopping here"); paint(); return; }
    logLine("starting a 6-second speech test — say a few words now");
    paint();

    await new Promise(function(resolve){
      var t = new SR(), done = false;
      t.continuous = true; t.interimResults = true; t.lang = "en-US";
      var finish = function(why){
        if(done) return; done = true;
        logLine("test finished (" + why + ")");
        try{ t.stop(); }catch(e){}
        paint(); resolve();
      };
      t.onstart = function(){ logLine("test: recognition started"); paint(); };
      t.onaudiostart = function(){ logLine("test: microphone open"); paint(); };
      t.onspeechstart = function(){ logLine("test: speech detected"); paint(); };
      t.onresult = function(ev){
        var s = "";
        for(var i = ev.resultIndex; i < ev.results.length; i++) s += ev.results[i][0].transcript;
        logLine("test: heard “" + s.trim() + "”"); paint();
      };
      t.onerror = function(ev){ logLine("test ERROR: " + (ev.error || "unknown") + (ev.message ? " — " + ev.message : "")); paint(); };
      t.onend = function(){ finish("ended"); };
      try{ t.start(); }
      catch(e){ logLine("test start() threw: " + (e && (e.name + " " + e.message))); finish("could not start"); }
      setTimeout(function(){ finish("6s elapsed"); }, 6000);
    });

    logLine("check complete — tap Copy report");
    paint();
  }

  on("#diag-run", "click", function(){ runDiag(); });
  on("#diag-copy", "click", function(){
    copy($("#diag-log").textContent, "Report copied — paste it to Claude");
  });

  /* ============================ boot ============================ */

  store = readStore();
  if(!store.activeId && store.episodes.length) store.activeId = store.episodes[0].id;
  applySeed();
  setHandKind("word");
  render();
  save();

  /* ?add=word&heard=sentence — for a phone shortcut or voice assistant */
  try{
    var params = new URLSearchParams(location.search);
    if(params.get("add")){
      var a = addWord(params.get("add"), params.get("heard") || params.get("sentence") || "", "typed");
      if(a) toast("Caught “" + a.word + "”");
    }
    if(params.get("note")){
      if(addNote(params.get("note"), "typed")) toast("Note saved");
    }
    /* ?title=…&url=… — the Mac transcript script opens Earshot like this, with
       the transcript already on the clipboard and waiting to be pasted. */
    var pTitle = params.get("title"), pUrl = params.get("url");
    if(pTitle || pUrl){
      $("#ep-panel").classList.add("open");
      renderEpisodeList();
      $("#ep-name").value = pTitle || "";
      $("#ep-url").value = pUrl || "";
      $("#ep-transcript").focus();
      notice(params.get("paste")
        ? "Episode ready — the transcript is on your clipboard. Long-press the transcript box and paste, then tap <strong>Start this episode</strong>."
        : "Episode ready — paste the transcript below and tap <strong>Start this episode</strong>.");
    }

    if(params.get("add") || params.get("note") || pTitle || pUrl){
      history.replaceState(null, "", location.pathname);
    }
  }catch(e){}

  if(!SR){
    notice("This browser cannot listen for you. Chrome on Android and Safari on iOS can — meanwhile, tap <strong>Type</strong> to add things by hand.", true);
  }

  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("sw.js").catch(function(){});
    });
  }
})();
