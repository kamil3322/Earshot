(function(){
  "use strict";

  /* ---------------------------------------------------------------
     Definitions Claude has filled in are seeded here on republish.
     Keyed by lowercase word.
  ----------------------------------------------------------------*/
  var SEED = {};

  var KEY = "earshot.v1";
  var $ = function(s){ return document.querySelector(s); };
  var entries = [];
  var filter = "all";
  var query = "";

  /* ------------------------- storage ------------------------- */
  function readLocal(){
    try{
      var raw = localStorage.getItem(KEY);
      if(!raw) return [];
      var d = JSON.parse(raw);
      return Array.isArray(d) ? d : (d.entries || []);
    }catch(e){ return []; }
  }
  function writeLocal(){
    try{ localStorage.setItem(KEY, JSON.stringify({v:1, entries:entries})); }catch(e){}
  }
  function mergeLists(a, b){
    var map = {};
    (a||[]).concat(b||[]).forEach(function(e){
      if(!e || !e.id) return;
      var prev = map[e.id];
      if(!prev || (e.updatedAt||0) >= (prev.updatedAt||0)) map[e.id] = e;
    });
    return Object.keys(map).map(function(k){ return map[k]; })
      .filter(function(e){ return !e.deleted; })
      .sort(function(x,y){ return (y.createdAt||0) - (x.createdAt||0); });
  }

  /* ------------------------- save state ------------------------- */
  function setSync(state, msg){
    var dot = $("#sync-dot"), txt = $("#sync-text");
    dot.className = "dot" + (state === "saved" ? " ok" : state === "error" ? " warn" : "");
    txt.textContent = msg;
  }

  function scheduleSave(){
    writeLocal();
    var n = entries.length;
    setSync("saved", n + (n === 1 ? " word saved on this device" : " words saved on this device"));
  }

  /* ------------------------- backup / restore ------------------------- */
  function backup(){
    var payload = JSON.stringify({app:"earshot", v:1, exportedAt:new Date().toISOString(), entries:entries}, null, 2);
    var blob = new Blob([payload], {type:"application/json"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var d = new Date();
    a.href = url;
    a.download = "earshot-" + d.toISOString().slice(0,10) + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
      var before = entries.length;
      entries = mergeLists(entries, incoming);
      applySeed();
      scheduleSave();
      render();
      out.hidden = false;
      out.innerHTML = "Restored — <b>" + (entries.length - before) + "</b> new, <b>" + entries.length + "</b> in total.";
      toast("Backup restored");
    };
    reader.readAsText(file);
  }

  /* ------------------------- entries ------------------------- */
  function makeId(){
    return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  }
  function cleanWord(w){
    return String(w || "").toLowerCase().replace(/[^a-z'’\- ]/g, "").trim();
  }
  function addEntry(word, sentence, source){
    var w = cleanWord(word);
    if(w.length < 2) return null;
    var now = Date.now();
    var dupe = entries.filter(function(e){ return e.word === w; })[0];
    if(dupe && now - (dupe.createdAt||0) < 60000) return null;
    var entry = {
      id: makeId(), word: w,
      sentence: String(sentence || "").trim(),
      source: source || "voice",
      createdAt: now, updatedAt: now,
      meaning:"", example:"", ipa:"", pos:""
    };
    if(SEED[w]) Object.assign(entry, pickDef(SEED[w]));
    entries.unshift(entry);
    scheduleSave();
    render();
    return entry;
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
    entries.forEach(function(e){
      if(!e.meaning && SEED[e.word]){ Object.assign(e, pickDef(SEED[e.word])); e.updatedAt = Date.now(); n++; }
    });
    return n;
  }
  function removeEntry(id){
    entries = entries.filter(function(e){ return e.id !== id; });
    scheduleSave(); render();
  }

  /* ------------------------- rendering ------------------------- */
  function esc(s){
    return String(s || "").replace(/[&<>"']/g, function(c){
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
  function render(){
    var list = $("#list");
    var shown = entries.filter(function(e){
      if(filter === "pending" && e.meaning) return false;
      if(filter === "done" && !e.meaning) return false;
      if(query){
        var hay = (e.word + " " + e.sentence + " " + e.meaning).toLowerCase();
        if(hay.indexOf(query) === -1) return false;
      }
      return true;
    });

    $("#c-total").textContent = entries.length;
    $("#c-pending").textContent = entries.filter(function(e){ return !e.meaning; }).length;

    if(!shown.length){
      list.innerHTML = '<div class="empty"><strong>' +
        (entries.length ? "Nothing matches that filter." : "No words yet.") + "</strong>" +
        (entries.length ? "Try another filter or clear the search."
          : "Tap <em>Start listening</em>, keep this page open while your podcast plays, and say &ldquo;save&rdquo; followed by the word you did not know.") +
        "</div>";
      return;
    }

    list.innerHTML = shown.map(function(e){
      var head = '<div class="head"><span class="word">' + esc(e.word) + "</span>" +
        (e.ipa ? '<span class="ipa">' + esc(e.ipa) + "</span>" : "") +
        (e.pos ? '<span class="pos">' + esc(e.pos) + "</span>"
               : (e.meaning ? "" : '<span class="pending">meaning pending</span>')) +
        "</div>";
      var meaning = e.meaning ? '<p class="meaning">' + esc(e.meaning) + "</p>" : "";
      var quote = e.sentence ? '<p class="quote">&ldquo;' + esc(e.sentence) + "&rdquo;</p>" : "";
      var example = e.example ? '<p class="example">' + esc(e.example) + "</p>" : "";
      var foot = '<div class="foot"><span>' + when(e.createdAt) + "</span>" +
        '<span>' + (e.via === "transcript" ? "transcript" : e.source === "voice" ? "voice" : "typed") + "</span>" +
        '<span class="spacer"></span>' +
        '<button type="button" data-edit="' + e.id + '">Edit sentence</button>' +
        '<button type="button" class="del" data-del="' + e.id + '">Delete</button></div>';
      return '<article class="card">' + head + meaning + quote + example + foot + "</article>";
    }).join("");
  }

  /* ------------------------- toast ------------------------- */
  var toastTimer = null;
  function toast(msg){
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    $("#live-region").textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 2200);
  }
  function notice(msg, warn){
    $("#notice-slot").innerHTML = '<div class="notice' + (warn ? " warn" : "") + '">' + msg + "</div>";
  }

  /* ------------------------- speech ------------------------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, wantListening = false, restartTimer = null;
  var heard = [];            // {text, t}
  var TRIGGERS = ["save", "catch", "note down", "note"];
  var STOP = {"the":1,"a":1,"an":1,"it":1,"this":1,"that":1,"word":1,"and":1,"is":1,"to":1};

  function ribbon(text, live){
    var el = $("#ribbon-text");
    el.innerHTML = "<bdi>" + esc(text || "Nothing yet.") + "</bdi>";
    el.style.color = live ? "var(--ink)" : "";
  }

  function contextBefore(cutoff){
    var out = [];
    for(var i = heard.length - 1; i >= 0; i--){
      if(heard[i].t >= cutoff) continue;
      if(Date.now() - heard[i].t > 30000) break;
      out.unshift(heard[i].text);
      if(out.join(" ").length > 180) break;
    }
    return out.join(" ").trim();
  }

  function handleFinal(text){
    var now = Date.now();
    var clean = text.trim();
    if(!clean) return;
    ribbon(clean, false);

    var lower = " " + clean.toLowerCase() + " ";
    var best = -1, bestTrigger = "";
    TRIGGERS.forEach(function(t){
      var idx = lower.lastIndexOf(" " + t + " ");
      if(idx > best){ best = idx; bestTrigger = t; }
    });

    if(best === -1){
      heard.push({text: clean, t: now});
      if(heard.length > 40) heard.shift();
      return;
    }

    var rest = clean.slice(best + bestTrigger.length + 1).trim();
    rest = rest.replace(/^(the\s+word\s+|word\s+)/i, "").trim();
    var tokens = rest.split(/\s+/).filter(Boolean);
    if(!tokens.length) return;

    var word = tokens[0];
    if(STOP[cleanWord(word)] && tokens.length > 1){ tokens.shift(); word = tokens[0]; }
    var sentence = tokens.slice(1).join(" ").trim();
    if(!sentence) sentence = contextBefore(now);

    var added = addEntry(word, sentence, "voice");
    if(added){
      toast("Caught “" + added.word + "”");
      if(navigator.vibrate) try{ navigator.vibrate(35); }catch(e){}
    }
  }

  /* ---- event log, so a silent failure becomes a readable report ---- */
  var logLines = [];
  function logLine(msg){
    var d = new Date();
    var stamp = ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    logLines.push(stamp + "  " + msg);
    if(logLines.length > 60) logLines.shift();
    var el = document.getElementById("diag-log");
    if(el && el.dataset.live === "1"){ el.textContent = logLines.join("\n"); el.scrollTop = el.scrollHeight; }
  }

  function buildRecognizer(){
    var r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onstart = function(){ logLine("recognition started"); };
    r.onaudiostart = function(){ logLine("microphone open (audio flowing)"); };
    r.onsoundstart = function(){ logLine("sound detected"); };
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
        notice("iOS refused the microphone for this page (<code>" + esc(ev.error) + "</code>). Run the microphone check at the bottom of this page and send me the report.", true);
      }else if(ev.error === "network"){
        notice("Speech recognition could not reach Apple&rsquo;s service. Check your connection — it will keep retrying.", true);
      }else if(ev.error !== "no-speech" && ev.error !== "aborted"){
        notice("Speech recognition stopped: <code>" + esc(ev.error || "unknown") + "</code>. The microphone check at the bottom has the details.", true);
      }
    };
    r.onend = function(){
      logLine("recognition ended" + (wantListening ? " — restarting" : ""));
      if(wantListening){
        clearTimeout(restartTimer);
        restartTimer = setTimeout(function(){
          try{ r.start(); }catch(e){}
        }, 350);
      }else{
        setMic(false);
      }
    };
    return r;
  }

  function setMic(on){
    var b = $("#mic");
    b.setAttribute("aria-pressed", on ? "true" : "false");
    $("#mic-title").textContent = on ? "Listening" : "Start listening";
    $("#mic-sub").textContent = on ? "Say “save” + the word" : "Then say “save” + the word";
  }

  /* keep the screen awake so the mic stays alive while you listen */
  var wakeLock = null;
  async function holdScreen(){
    try{
      if(navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    }catch(e){}
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
    notice("Earshot keeps the screen awake while it listens. It only hears you while this page is the one in front — if you switch to another app, tap the mic again when you come back.");
  }
  function stopListening(){
    wantListening = false;
    clearTimeout(restartTimer);
    if(rec) try{ rec.stop(); }catch(e){}
    releaseScreen();
    setMic(false);
  }

  /* ------------------------- wiring ------------------------- */
  $("#mic").addEventListener("click", function(){
    if(!SR){
      notice("This browser cannot listen. Chrome on Android or Safari on iOS work — or tap <strong>Type</strong> to add words by hand.", true);
      return;
    }
    if(wantListening) stopListening(); else startListening();
  });

  $("#toggle-hand").addEventListener("click", function(){
    var h = $("#hand");
    h.classList.toggle("open");
    if(h.classList.contains("open")) $("#hand-word").focus();
  });
  $("#hand-cancel").addEventListener("click", function(){ $("#hand").classList.remove("open"); });
  $("#hand").addEventListener("submit", function(ev){
    ev.preventDefault();
    var w = $("#hand-word").value, s = $("#hand-sentence").value;
    var added = addEntry(w, s, "typed");
    if(added){
      toast("Added “" + added.word + "”");
      $("#hand-word").value = ""; $("#hand-sentence").value = "";
      $("#hand-word").focus();
    }else{
      toast("Type a word first");
    }
  });

  document.querySelectorAll(".chip").forEach(function(c){
    c.addEventListener("click", function(){
      filter = c.dataset.filter;
      document.querySelectorAll(".chip").forEach(function(o){
        o.setAttribute("aria-pressed", o === c ? "true" : "false");
      });
      render();
    });
  });
  $("#search").addEventListener("input", function(e){
    query = e.target.value.trim().toLowerCase(); render();
  });

  $("#list").addEventListener("click", function(ev){
    var del = ev.target.closest("[data-del]");
    if(del){
      var e1 = entries.filter(function(x){ return x.id === del.dataset.del; })[0];
      removeEntry(del.dataset.del);
      toast("Deleted “" + (e1 ? e1.word : "word") + "”");
      return;
    }
    var ed = ev.target.closest("[data-edit]");
    if(ed){
      var e2 = entries.filter(function(x){ return x.id === ed.dataset.edit; })[0];
      if(!e2) return;
      var next = window.prompt("The sentence you heard “" + e2.word + "” in:", e2.sentence || "");
      if(next === null) return;
      e2.sentence = next.trim(); e2.updatedAt = Date.now();
      scheduleSave(); render();
    }
  });

  function copy(text, okMsg){
    var done = function(){ toast(okMsg); };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, fallback);
    }else fallback();
    function fallback(){
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand("copy"); done(); }catch(e){ toast("Could not copy"); }
      document.body.removeChild(ta);
    }
  }

  $("#copy-words").addEventListener("click", function(){
    var pending = entries.filter(function(e){ return !e.meaning; });
    if(!pending.length){ toast("Every word already has a meaning"); return; }
    var payload = pending.map(function(e){ return {word:e.word, heard_in:e.sentence}; });
    var text = "These are English words I heard but did not know. For each one give a short plain-English meaning " +
      "(one or two sentences, matching how it is used in the sentence I heard), the IPA pronunciation, the part of speech, " +
      "and one fresh example sentence.\n\nReply with ONLY a JSON array like " +
      '[{"word":"","pos":"","ipa":"","meaning":"","example":""}] and nothing else.\n\n' +
      JSON.stringify(payload, null, 2);
    copy(text, "Copied — paste it into Claude");
  });

  $("#toggle-paste").addEventListener("click", function(){
    var p = $("#paste");
    p.classList.toggle("open");
    if(p.classList.contains("open")) $("#paste-box").focus();
  });

  $("#paste-apply").addEventListener("click", function(){
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
      entries.forEach(function(e){
        if(e.word === w && (!e.meaning || def.meaning)){
          Object.assign(e, def); e.updatedAt = Date.now(); applied++;
        }
      });
    });
    if(applied){
      scheduleSave(); render();
      $("#paste-box").value = "";
      $("#paste").classList.remove("open");
      toast(applied + (applied === 1 ? " meaning added" : " meanings added"));
    }else{
      toast("None of those words are in your list");
    }
  });

  /* ------------------ batch import ------------------ */
  $("#toggle-batch").addEventListener("click", function(){
    var el = $("#batch");
    el.classList.toggle("open");
    if(el.classList.contains("open")) $("#batch-box").focus();
  });

  $("#batch-apply").addEventListener("click", function(){
    var out = $("#batch-result");
    var lines = $("#batch-box").value.split(/[\n\r;]+/);
    var added = 0, skipped = 0;
    lines.forEach(function(line){
      var raw = line.trim();
      if(!raw) return;
      raw = raw.replace(/^[-*•\d.)\s]+/, "").trim();      // bullets and numbering
      var parts = raw.split(/\s+[—–-]\s+|\s*[:|\t]\s*/);        // word — sentence
      var word = parts.shift();
      var sentence = parts.join(" ").trim();
      var already = entries.filter(function(e){ return e.word === cleanWord(word); }).length;
      if(already){ skipped++; return; }
      if(addEntry(word, sentence, "typed")) added++; else skipped++;
    });
    out.hidden = false;
    out.innerHTML = "<b>" + added + "</b> " + (added === 1 ? "word added" : "words added") +
      (skipped ? ", " + skipped + " skipped (already there, or too short)" : "") + ".";
    if(added){
      $("#batch-box").value = "";
      toast(added + (added === 1 ? " word added" : " words added"));
    }
  });

  /* ------------------ microphone diagnostics ------------------ */
  function diagHeader(){
    var framed = "unknown";
    try{ framed = (window.self !== window.top) ? "YES — page runs inside a frame" : "no"; }catch(e){ framed = "YES — cross-origin frame"; }
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
    el.textContent = diagHeader() + "\nchecking…";

    var head = diagHeader();
    function paint(){ el.textContent = head + "\n" + logLines.join("\n"); el.scrollTop = el.scrollHeight; }

    // 1. permission state, where the browser exposes it
    try{
      if(navigator.permissions && navigator.permissions.query){
        var st = await navigator.permissions.query({name:"microphone"});
        logLine("permission state: " + st.state);
      }else logLine("permission state: not reported by this browser");
    }catch(e){ logLine("permission state: not reported (" + (e && e.name) + ")"); }
    paint();

    // 2. can we actually open the microphone?
    try{
      var stream = await navigator.mediaDevices.getUserMedia({audio:true});
      logLine("getUserMedia: OK — microphone opened");
      var tr = stream.getAudioTracks()[0];
      if(tr) logLine("audio track: " + (tr.label || "unnamed") + ", enabled=" + tr.enabled + ", muted=" + tr.muted);
      stream.getTracks().forEach(function(t){ t.stop(); });
    }catch(e){
      logLine("getUserMedia FAILED: " + (e && e.name) + " — " + (e && e.message));
    }
    paint();

    // 3. can speech recognition actually run for 6 seconds?
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
        logLine("test: heard “" + s.trim() + "”");
        paint();
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

  $("#diag-run").addEventListener("click", function(){ runDiag(); });
  $("#diag-copy").addEventListener("click", function(){
    copy($("#diag-log").textContent, "Report copied — paste it to Claude");
  });

  $("#backup").addEventListener("click", backup);
  $("#restore").addEventListener("click", function(){ $("#restore-file").click(); });
  $("#restore-file").addEventListener("change", function(ev){
    if(ev.target.files && ev.target.files[0]) restore(ev.target.files[0]);
    ev.target.value = "";
  });

  /* ------------------ transcript matching ------------------ */
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

  function prepTranscript(raw){
    return String(raw || "")
      .replace(/\r/g, "")
      .replace(/^\s*\[?\(?\d{1,2}:\d{2}(:\d{2})?\)?\]?\s*/gm, " ")
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
      .replace(/^\s*[A-Z][\w .'’-]{0,28}:\s+/gm, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sentencesOf(t){
    return (t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
      .map(function(s){ return s.trim(); })
      .filter(function(s){ return s.length > 1; });
  }

  function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function findSentence(sents, word){
    var re = new RegExp("\\b" + escRe(word) + "(?:s|es|ed|d|ing)?\\b", "i");
    for(var i = 0; i < sents.length; i++) if(re.test(sents[i])) return sents[i];
    return null;
  }

  function nearestToken(tokens, word){
    var best = null, bestD = 3;
    for(var t in tokens){
      if(Math.abs(t.length - word.length) > 2) continue;
      var d = editDistance(word, t, 2);
      if(d < bestD){ bestD = d; best = t; }
    }
    return bestD <= 2 ? best : null;
  }

  function clipAround(s, word){
    if(s.length <= 260) return s;
    var i = s.toLowerCase().indexOf(word.toLowerCase());
    if(i === -1) return s.slice(0, 257).trim() + "…";
    var start = Math.max(0, i - 110), end = Math.min(s.length, i + 150);
    return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
  }

  $("#toggle-transcript").addEventListener("click", function(){
    var t = $("#transcript");
    t.classList.toggle("open");
    if(t.classList.contains("open")) $("#transcript-box").focus();
  });

  $("#transcript-apply").addEventListener("click", function(){
    var out = $("#transcript-result");
    var text = prepTranscript($("#transcript-box").value);
    if(text.length < 40){
      out.hidden = false;
      out.innerHTML = "That looks too short to be a transcript — paste the whole episode text.";
      return;
    }
    if(!entries.length){ toast("No words to look for yet"); return; }

    var sents = sentencesOf(text);
    var tokens = {};
    (text.toLowerCase().match(/[a-z'’-]{4,}/g) || []).forEach(function(w){ tokens[w] = 1; });

    var matched = 0, fixed = 0, missed = [];
    entries.forEach(function(e){
      if(e.via === "transcript") return;
      var found = findSentence(sents, e.word), newWord = null;
      if(!found && !e.meaning){   // never re-spell a word whose meaning is already confirmed
        var alt = nearestToken(tokens, e.word);
        if(alt && alt !== e.word){
          found = findSentence(sents, alt);
          if(found) newWord = alt;
        }
      }
      if(found){
        if(newWord){ e.word = newWord; e.meaning = ""; e.example = ""; e.ipa = ""; e.pos = ""; fixed++; }
        e.sentence = clipAround(found, e.word);
        e.via = "transcript";
        e.updatedAt = Date.now();
        matched++;
      }else{
        missed.push(e.word);
      }
    });

    scheduleSave();
    render();
    out.hidden = false;
    out.innerHTML = "<b>" + matched + "</b> " + (matched === 1 ? "word found" : "words found") +
      " in this transcript" +
      (fixed ? ", <b>" + fixed + "</b> " + (fixed === 1 ? "spelling corrected" : "spellings corrected") : "") +
      "." +
      (missed.length ? " Not in this episode: <span class=\"miss\">" + esc(missed.slice(0, 12).join(", ")) +
        (missed.length > 12 ? " +" + (missed.length - 12) + " more" : "") + "</span>" : "");
    if(matched) toast(matched + (matched === 1 ? " sentence added" : " sentences added"));
  });

  $("#export").addEventListener("click", function(){
    if(!entries.length){ toast("Nothing to copy yet"); return; }
    var text = entries.map(function(e){
      return e.word +
        (e.pos ? " (" + e.pos + ")" : "") +
        (e.ipa ? " " + e.ipa : "") +
        (e.meaning ? "\n  " + e.meaning : "\n  [meaning pending]") +
        (e.sentence ? "\n  heard: “" + e.sentence + "”" : "") +
        (e.example ? "\n  example: " + e.example : "");
    }).join("\n\n");
    copy(text, "Whole list copied");
  });

  /* ------------------------- boot ------------------------- */
  entries = mergeLists(readLocal(), []);
  applySeed();
  render();

  /* ?add=word&heard=sentence — lets a phone shortcut or voice assistant
     drop a word in without the page being open first */
  try{
    var params = new URLSearchParams(location.search);
    var viaUrl = params.get("add");
    if(viaUrl){
      var addedUrl = addEntry(viaUrl, params.get("heard") || params.get("sentence") || "", "voice");
      if(addedUrl) toast("Caught “" + addedUrl.word + "”");
      history.replaceState(null, "", location.pathname);
    }
  }catch(e){}

  if(!SR){
    notice("This browser cannot listen for you. Chrome on Android and Safari on iOS can — meanwhile, tap <strong>Type</strong> to add words by hand.", true);
  }
  scheduleSave();

  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("sw.js").catch(function(){});
    });
  }
})();
