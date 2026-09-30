const API = '';
let currentTab = 'chat';
let radarChart = null;

// ── Tab switching ──
document.querySelectorAll('.tab').forEach(function(t) {
  t.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(x) { x.classList.remove('active'); });
    t.classList.add('active');
    currentTab = t.dataset.tab;
    document.querySelectorAll('.tab-content').forEach(function(x) { x.classList.remove('active'); });
    var el = document.getElementById('tab-' + currentTab);
    if (el) el.classList.add('active');
    if (currentTab === 'reads') refreshReads();
    if (currentTab === 'reads') refreshReads();
    if (currentTab === 'signals') refreshSignals();
    if (currentTab === 'drives') refreshDrives();
    if (currentTab === 'status') refreshStatus();
  });
});

// ── Chat ──
async function send() {
  var input = document.getElementById('input');
  var text = input.value.trim();
  if (!text) return;
  input.value = ''; input.focus();

  var msgs = document.getElementById('msgs');
  msgs.innerHTML += '<div class="msg user">' + esc(text) + '<div class="time">' + now() + '</div></div>';

  var bubble = document.createElement('div');
  bubble.className = 'msg assistant streaming';
  bubble.innerHTML = '...';
  msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;

  try {
    var r = await fetch(API + '/api/v2/chat/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    });
    var fullText = '';
    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buf += decoder.decode(result.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('data: ') !== 0) continue;
        try {
          var d = JSON.parse(line.slice(6));
          if (d.type === 'token') { fullText += d.text; bubble.textContent = fullText; msgs.scrollTop = msgs.scrollHeight; }
          if (d.type === 'signals') updateRadar(d.signals);
          if (d.type === 'done' && d.reply) fullText = d.reply;
        } catch (_) {}
      }
    }
    bubble.classList.remove('streaming');
    bubble.innerHTML = esc(fullText) + '<div class="time">' + now() + '</div>';
    msgs.scrollTop = msgs.scrollHeight;
    refreshAll();
  } catch (e) {
    bubble.textContent = '连接失败: ' + e.message;
    bubble.classList.remove('streaming');
  }
}

document.getElementById('sendBtn').addEventListener('click', send);
document.getElementById('input').addEventListener('keydown', function(e) { if (e.key === 'Enter') send(); });

// ── Radar chart ──
var radarLabels = ['直接度','坦露度','玩闹度','主动度','深度','温暖度','倔强度','好奇度'];

function updateRadar(signals) {
  var values = [signals.directness, signals.vulnerability, signals.playfulness, signals.initiative, signals.depth, signals.warmth, signals.defiance, signals.curiosity];
  if (radarChart) {
    radarChart.data.datasets[0].data = values;
    radarChart.update();
  }
}

function refreshSignals() {
  fetch(API + '/api/v2/signals').then(function(r) { return r.json(); }).then(function(data) {
    var s = data.signals;
    var values = [s.directness, s.vulnerability, s.playfulness, s.initiative, s.depth, s.warmth, s.defiance, s.curiosity];

    if (radarChart) {
      radarChart.data.datasets[0].data = values;
      radarChart.update();
    } else {
      var ctx = document.getElementById('radarChart').getContext('2d');
      radarChart = new Chart(ctx, {
        type: 'radar',
        data: {
          labels: radarLabels,
          datasets: [{
            label: '行为信号', data: values,
            backgroundColor: 'rgba(226,168,62,0.12)',
            borderColor: 'rgba(226,168,62,0.8)',
            pointBackgroundColor: 'rgba(226,168,62,1)',
            pointBorderColor: '#1a1a2e',
            pointRadius: 4,
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          scales: {
            r: {
              min: 0, max: 1,
              ticks: { stepSize: 0.2, color: '#7a6f88', backdropColor: 'transparent', font: { size: 10 } },
              grid: { color: 'rgba(255,255,255,0.06)' },
              pointLabels: { color: '#d4c8b0', font: { size: 11 } },
              angleLines: { color: 'rgba(255,255,255,0.06)' },
            },
          },
          plugins: { legend: { display: false } },
        },
      });
    }

    var hints = [];
    if (s.directness > 0.7) hints.push('直白模式');
    if (s.vulnerability > 0.7) hints.push('袒露模式');
    if (s.playfulness > 0.7) hints.push('玩闹模式');
    if (s.initiative > 0.7) hints.push('主导模式');
    if (s.depth > 0.7) hints.push('深度模式');
    if (s.warmth > 0.7) hints.push('温暖模式');
    if (s.defiance > 0.7) hints.push('叛逆模式');
    if (s.curiosity > 0.7) hints.push('好奇模式');
    if (hints.length === 0) hints.push('中性状态');
    document.getElementById('signalHints').innerHTML = '温度: ' + data.temperature.toFixed(3) + ' | 挫败累积: ' + data.frustrationAccumulator.toFixed(2) + '<br>活跃信号: ' + hints.join(', ');
  }).catch(function() {});
}

// ── Drives ──
var driveColors = { connection: '#6080c0', novelty: '#60a080', expression: '#e0a040', safety: '#60a0a0', play: '#a060d0' };
var driveNames = { connection: '联结', novelty: '新鲜', expression: '表达', safety: '安全', play: '玩闹' };

function refreshDrives() {
  fetch(API + '/api/v2/drives').then(function(r) { return r.json(); }).then(function(data) {
    var ds = data.drives;
    var html = '';
    for (var id in ds) {
      if (!ds.hasOwnProperty(id)) continue;
      var d = ds[id];
      var color = driveColors[id] || '#888';
      var fColor = d.frustration > 2 ? '#e06060' : '#f0c060';
      html += '<div class="drive-row">';
      html += '<span class="drive-label">' + (driveNames[id] || id) + '</span>';
      html += '<div class="drive-bar-bg"><div class="drive-bar val" style="width:' + (d.value * 100 | 0) + '%;background:' + color + ';opacity:0.4"></div></div>';
      html += '<span class="drive-val">渴' + (d.value * 100 | 0) + '%</span>';
      html += '<div class="drive-bar-bg" style="flex:0.5"><div class="drive-bar" style="width:' + (d.frustration / 5 * 100 | 0) + '%;background:' + fColor + '"></div></div>';
      html += '<span class="drive-val">挫' + d.frustration.toFixed(1) + '</span></div>';
      html += '<div style="font-size:10px;color:var(--muted);margin-left:78px">基线:' + (d.baseline || 0.2).toFixed(2) + ' 满足:' + (d.satisfaction || 0).toFixed(2) + ' 饥饿:' + d.hungerRate + '/h</div>';
    }
    document.getElementById('driveBars').innerHTML = html;

    var temp = data.temperature;
    var g = document.getElementById('tempGauge');
    g.textContent = temp.toFixed(3);
    g.className = 'temp-gauge ' + (temp > 0.2 ? 'hot' : temp > 0.1 ? 'warm' : 'cool');
    document.getElementById('tempLabel').textContent = '总挫败: ' + data.totalFrustration.toFixed(1);
    document.getElementById('tempMini').textContent = temp.toFixed(2);

    if (data.impulse) {
      document.getElementById('impulseMini').textContent = data.impulse.label;
      document.getElementById('impulseMini').style.color = '#f0c060';
    } else {
      document.getElementById('impulseMini').textContent = '--';
      document.getElementById('impulseMini').style.color = '';
    }
  }).catch(function() {});
}

// ── Status ──
function refreshStatus() {
  fetch(API + '/api/v2/status').then(function(r) { return r.json(); }).then(function(data) {
    var gs = data.genomeState;
    var fp = gs.fingerprint || {};
    var traits = fp.traits || {};
    var nonNeutral = [];
    for (var k in traits) { if (traits[k] !== 'neutral') nonNeutral.push(k + ':' + traits[k]); }

    document.getElementById('genomeStats').innerHTML = [
      ['交互次数', gs.interactionCount],
      ['总奖励', gs.totalReward],
      ['挫败累积', gs.frustrationAccumulator + ' / ' + gs.phaseThreshold],
      ['信号指纹', nonNeutral.join(', ') || '无'],
    ].map(function(p) { return '<div class="stat-row"><span class="stat-label">' + p[0] + '</span><span>' + p[1] + '</span></div>'; }).join('');

    document.getElementById('memStats').innerHTML = [
      ['记忆点数', data.memoryState.totalPoints],
      ['总质量', data.memoryState.totalMass],
    ].map(function(p) { return '<div class="stat-row"><span class="stat-label">' + p[0] + '</span><span>' + p[1] + '</span></div>'; }).join('');

    var ps = data.proactiveState;
    document.getElementById('proactiveStats').innerHTML = [
      ['tick次数', ps.tickCount],
      ['冲动触发', ps.impulseTriggers],
      ['静默次数', ps.silenceChosen],
      ['消息送出', ps.messagesDelivered],
      ['待发队列', ps.pendingCount],
      ['距上次发送', ps.lastSentMinAgo ? ps.lastSentMinAgo + 'min' : '从未'],
      ['冷却期', ps.cooldownMin + 'min'],
      ['tick间隔', ps.tickIntervalMin + 'min'],
    ].map(function(p) { return '<div class="stat-row"><span class="stat-label">' + p[0] + '</span><span>' + p[1] + '</span></div>'; }).join('');
  }).catch(function() {});
}

// ── Archive reads ──
function refreshReads() {
  fetch(API + '/api/v2/reads').then(function(r) { return r.json(); }).then(function(data) {
    document.getElementById('readsCount').textContent = data.totalReads;

    // Status line
    var lastAt = data.lastReadAt ? new Date(data.lastReadAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未';
    document.getElementById('readsStatus').innerHTML =
      '上次阅读: ' + lastAt + ' · 间隔: ' + data.intervalMin + 'min · 资料库: ' + esc(data.archiveDir || '--');

    // List
    var reads = data.reads || [];
    if (reads.length === 0) {
      document.getElementById('readsList').innerHTML = '<div style="color:var(--muted);font-size:13px;">还没有读过资料。把文件放到 archive 文件夹后，AI 会在活跃窗口自动阅读。</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < reads.length; i++) {
      var r = reads[i];
      var time = r.time ? new Date(r.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '';
      var worthBadge = r.worth
        ? '<span style="color:var(--accent);font-size:10px;">有价值</span>'
        : '<span style="color:var(--muted);font-size:10px;">跳过</span>';
      var contBadge = !r.done
        ? '<span style="color:var(--warn);font-size:10px;">待续</span>'
        : '';

      html += '<div class="panel-card" style="padding:12px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
      html += '<span style="font-size:13px;font-weight:bold;color:var(--gold);">' + esc(r.title || r.basename) + '</span>';
      html += '<span style="font-size:10px;color:var(--muted);">' + time + '</span>';
      html += '</div>';
      html += '<div style="font-size:12px;color:var(--text);line-height:1.6;">' + esc(r.note || '') + '</div>';
      html += '<div style="display:flex;justify-content:space-between;margin-top:6px;">';
      html += '<span style="font-size:10px;color:var(--muted);">' + esc(r.basename) + ' (' + (r.charCount || 0) + '/' + (r.totalChars || 0) + '字)</span>';
      html += '<span>' + worthBadge + ' ' + contBadge + '</span>';
      html += '</div></div>';
    }
    document.getElementById('readsList').innerHTML = html;
  }).catch(function(e) {
    document.getElementById('readsList').innerHTML = '<div style="color:var(--muted);">加载失败: ' + e.message + '</div>';
  });
}

function refreshAll() { refreshDrives(); if (currentTab === 'reads') refreshReads(); if (currentTab === 'signals') refreshSignals(); if (currentTab === 'status') refreshStatus(); }

// ── Load chat history on init ──
var _lastMsgCount = 0;
function loadChatHistory() {
  fetch(API + '/api/v2/history').then(function(r) { return r.json(); }).then(function(hist) {
    if (!hist || !hist.length) return;
    var msgs = document.getElementById('msgs');
    var html = '';
    var start = Math.max(0, hist.length - 10);
    for (var i = start; i < hist.length; i++) {
      var h = hist[i];
      var role = h.role === 'user' ? 'user' : 'assistant';
      var time = h.time ? new Date(h.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      html += '<div class="msg ' + role + '">' + esc(h.text || '') + '<div class="time">' + time + '</div></div>';
    }
    msgs.innerHTML = html;
    msgs.scrollTop = msgs.scrollHeight;
    _lastMsgCount = hist.length;
  }).catch(function() {});
}

// ── Polling ──
setInterval(function() {
  fetch(API + '/api/v2/status').then(function(r) { return r.json(); }).then(function() {
    document.getElementById('uptime').textContent = 'v2';
    refreshDrives();
    if (currentTab === 'reads') refreshReads();
    if (currentTab === 'status') refreshStatus();
  }).catch(function() {});

  // Poll for new proactive messages
  fetch(API + '/api/v2/history').then(function(r) { return r.json(); }).then(function(hist) {
    if (!hist || !hist.length) return;
    var newCount = hist.length;
    if (newCount > _lastMsgCount && _lastMsgCount > 0) {
      var msgs = document.getElementById('msgs');
      for (var i = _lastMsgCount; i < newCount; i++) {
        var h = hist[i];
        var role = h.role === 'user' ? 'user' : 'assistant';
        var time = h.time ? new Date(h.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        msgs.innerHTML += '<div class="msg ' + role + '">' + esc(h.text || '') + '<div class="time">' + time + '</div></div>';
      }
      msgs.scrollTop = msgs.scrollHeight;
    }
    _lastMsgCount = newCount;
  }).catch(function() {});
}, 30000);

// ── Utils ──
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function now() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

// ── Image compression ──
function compressImage(dataUrl, cb) {
  var img = new Image();
  img.onload = function() {
    var maxW = 1920, maxH = 1920;
    var w = img.width, h = img.height;
    if (w <= maxW && h <= maxH) { cb(dataUrl); return; }
    var ratio = Math.min(maxW / w, maxH / h);
    w = Math.round(w * ratio); h = Math.round(h * ratio);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    cb(c.toDataURL('image/jpeg', 0.8));
  };
  img.onerror = function() { cb(dataUrl); };
  img.src = dataUrl;
}

// ── Image queue (pending images wait for text, then send together) ──
var pendingImages = [];

function handleImage(e) {
  var files = e.target.files;
  if (!files || !files.length) return;
  var msgs = document.getElementById('msgs');
  var loaded = 0;

  for (var i = 0; i < files.length; i++) {
    (function(file) {
      var reader = new FileReader();
      reader.onload = function(ev) {
        compressImage(ev.target.result, function(compressed) {
          pendingImages.push(compressed.split(',')[1]);
          msgs.innerHTML += '<div class="msg user"><img src="' + compressed + '" style="max-width:200px;max-height:200px;border-radius:8px;"><div class="time">' + now() + '</div></div>';
          loaded++;
        });
      };
      reader.readAsDataURL(file);
    })(files[i]);
  }
  e.target.value = '';
}

// Modified send: if images pending, send to vision API with text as context
var _origSend = send;
send = async function() {
  if (pendingImages.length > 0) {
    var input = document.getElementById('input');
    var text = input.value.trim();
    input.value = ''; input.focus();
    var msgs = document.getElementById('msgs');

    var imgs = pendingImages.slice();
    pendingImages = [];
    msgs.scrollTop = msgs.scrollHeight;

    var bubble = document.createElement('div');
    bubble.className = 'msg assistant streaming';
    bubble.innerHTML = '看图' + (imgs.length > 1 ? ' (' + imgs.length + '张)...' : '...');
    msgs.appendChild(bubble);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      var r = await fetch(API + '/api/v2/vision/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64s: imgs, context: text || undefined }),
      });
      var data = await r.json();
      var reply = data.reply || '图挂了，没加载出来';
      bubble.classList.remove('streaming');
      bubble.innerHTML = esc(reply) + '<div class="time">' + now() + '</div>';
      msgs.scrollTop = msgs.scrollHeight;
    } catch (e) {
      bubble.textContent = '连接失败: ' + e.message;
      bubble.classList.remove('streaming');
    }
    return;
  }
  return _origSend();
};

document.getElementById('imgBtn').addEventListener('click', function() {
  document.getElementById('imageInput').click();
});

// ── History viewer ──
document.getElementById('historyBtn').addEventListener('click', function() {
  fetch(API + '/api/v2/history').then(function(r) { return r.json(); }).then(function(hist) {
    var html = '';
    for (var i = hist.length - 1; i >= 0; i--) {
      var h = hist[i];
      var role = h.role === 'user' ? '你' : 'AI';
      var color = h.role === 'user' ? 'var(--border)' : 'var(--panel)';
      html += '<div style="margin:8px 0;padding:8px 12px;background:' + color + ';border-radius:8px;font-size:13px;">';
      html += '<span style="color:var(--muted);font-size:10px;">' + role + ' · ' + (h.time ? new Date(h.time).toLocaleString('zh-CN') : '-') + '</span><br>';
      html += esc(h.text || '').slice(0, 200);
      html += '</div>';
    }
    if (!html) html = '<div style="color:var(--muted);">暂无记录</div>';
    document.getElementById('historyContent').innerHTML = html;
    document.getElementById('historyOverlay').style.display = 'block';
  })['catch'](function() {});
});

// ── Prompt viewer ──
document.getElementById('promptBtn').addEventListener('click', function() {
  fetch(API + '/api/v2/prompt').then(function(r) { return r.json(); }).then(function(data) {
    var prompt = data.prompt || '(暂无)';
    document.getElementById('promptContent').textContent = prompt;
    document.getElementById('promptOverlay').style.display = 'block';
  })['catch'](function() {});
});

// Init
loadChatHistory();
refreshAll();
