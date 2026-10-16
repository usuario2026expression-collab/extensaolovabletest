"use strict";
// content.js — Captura token/projectId sem injetar nada na página
const _QO_URL = 'https://hckncgrfhedoswsdkyni.supabase.co/functions/v1/optimize-prompt';
const _QO_KEY = ['eyJhbGciOiJIUzI1NiI','sInR5cCI6IkpXVCJ9.e',
  'yJpc3MiOiJzdXBhYmFz','ZSIsInJlZiI6Imhja25',
  'jZ3JmaGVkb3N3c2RreW','5pIiwicm9sZSI6ImFub',
  '24iLCJpYXQiOjE3Nzk4','MTM5NjksImV4cCI6MjA',
  '5NTM4OTk2OX0.NcmiFO','kEjVGS3oP16Ai6pHzmp',
  'ktUShVzPUQYCXfH-dQ'].join('');
// Token capturado por: 1) webRequest.onBeforeSendHeaders no background.js (via rede)
//                      2) localStorage polling aqui (fallback para tokens já existentes)
//                      3) postMessage do castle-capture.js (world MAIN não tem chrome.runtime)
// ZERO injeção no contexto da página — sem wrapFetch, sem XHR wrap, sem pageHook

// ── Ponte: castle-capture.js (MAIN world) → background.js (storage) ─────────
// castle-capture.js roda no world MAIN e não tem acesso a chrome.runtime, então
// avisa via postMessage; aqui (world ISOLATED) repassamos para o cache que o
// modal "Criar Projeto" (sp-create-modal) consulta antes de mostrar o aviso.
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (e.data && e.data.type === "__ql_castle_token__" && e.data.token) {
    chrome.runtime.sendMessage({ action: "lovable_castleToken", token: e.data.token });
  }
});

// ── Obtém o próprio tabId via background ───────────────────────────────────
let _myTabId = null;
try {
  chrome.runtime.sendMessage({ action: "getMyTabId" }, (resp) => {
    void chrome.runtime.lastError;
    if (resp && resp.tabId != null) _myTabId = resp.tabId;
  });
} catch(e) {}

// Lê o access_token Supabase do localStorage (e sessionStorage como fallback)
function readTokenFromLocalStorage() {
  const stores = [localStorage, sessionStorage];
  for (const store of stores) {
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) {
          const data = JSON.parse(store.getItem(key));
          if (data && data.access_token) return data.access_token;
        }
      }
    } catch(e) {}
  }
  return null;
}

// Decodifica o JWT (sem validar assinatura — só lê o campo exp) e diz se já
// expirou. Token não-JWT (ou ilegível) retorna false — não bloqueia, deixa o
// servidor decidir; aqui só queremos pular tentativas que JÁ sabemos que vão
// falhar (evita gastar retry/round-trip contra um token visivelmente vencido).
function isTokenExpired(token) {
  try {
    const parts = (token || '').replace(/^Bearer\s+/i, '').split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return !!(payload.exp && payload.exp * 1000 < Date.now());
  } catch (_) { return false; }
}

// Extrai projectId da URL da aba atual (lovable.dev/projects/UUID)
function getProjectFromUrl() {
  try {
    const m = window.location.pathname.match(/\/projects\/([0-9a-fA-F-]{36})/i) ||
              window.location.href.match(/\/projects\/([0-9a-fA-F-]{36})/i);
    return m ? m[1] : null;
  } catch(e) { return null; }
}

// Salva token e/ou projectId no chrome.storage.local — retorna uma Promise que só
// resolve depois do set() de fato terminar (chamadores que precisam GARANTIR que o
// storage já está atualizado antes de prosseguir, ex: refreshTokenFromPage antes de
// enviar, devem usar await; sync periódico/oportunista pode ignorar o retorno).
function saveToStorage(token, projectId) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime?.id) { resolve(); return; }
      const updates = {};
      if (token && typeof token === "string") {
        updates.lovable_token = token.replace(/^Bearer\s+/i, "").trim();
      }
      if (projectId && typeof projectId === "string") {
        updates.lovable_projectId = projectId;
      }
      // Chaves tab-specific: o sidepanel lê lov_tok_${tabId} em vez da chave global
      if (_myTabId != null) {
        if (updates.lovable_token)     updates[`lov_tok_${_myTabId}`] = updates.lovable_token;
        if (updates.lovable_projectId) updates[`lov_pid_${_myTabId}`] = updates.lovable_projectId;
      }
      if (!Object.keys(updates).length) { resolve(); return; }
      chrome.storage.local.set(updates, () => resolve());
    } catch(e) { resolve(); }
  });
}

// Sync periódico: garante que o storage sempre tem o token mais recente
// (fallback — o webRequest no background.js já faz isso via rede)
setInterval(function() {
  try {
    const freshToken = readTokenFromLocalStorage();
    const pid = getProjectFromUrl();
    if (freshToken || pid) saveToStorage(freshToken, pid);
  } catch(e) {}
}, 2000); // reduzido de 4000 → 2000ms para captura mais rápida

// Re-captura token quando a aba volta a ficar visível (ex: usuário alterna janelas)
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    try {
      const freshToken = readTokenFromLocalStorage();
      const pid = getProjectFromUrl();
      if (freshToken || pid) saveToStorage(freshToken, pid);
    } catch(e) {}
  }
});

// ── Aviso de gasto de crédito (nível de arquivo — acessível por todos os IIFEs) ──
// Quando a extensão está INATIVA e o usuário tenta enviar nativamente,
// mostra um modal alertando que vai gastar créditos e oferece cancelar+reload.
let _creditModal = null;
let _creditWarningAllowed = false; // true: deixa o próximo send passar (usuário confirmou)

function _showCreditWarningModal(onContinue) {
  if (_creditModal) { try { _creditModal.remove(); } catch(_){} _creditModal = null; }

  const ov = document.createElement('div');
  ov.id = '__ql_credit_warn__';
  ov.setAttribute('style', [
    'position:fixed','top:0','left:0','right:0','bottom:0',
    'z-index:2147483647',
    'display:flex','align-items:center','justify-content:center',
    'background:rgba(0,0,0,0.78)',
    'backdrop-filter:blur(8px)',
    '-webkit-backdrop-filter:blur(8px)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'padding:20px',
    'box-sizing:border-box',
  ].join(';'));

  ov.innerHTML = '<div style="' + [
    'background:#13131f',
    'border:1.5px solid rgba(239,68,68,0.55)',
    'border-radius:22px',
    'padding:32px 28px 26px',
    'max-width:400px','width:100%',
    'box-shadow:0 0 0 1px rgba(239,68,68,0.15),0 24px 64px rgba(0,0,0,0.7),0 0 50px rgba(239,68,68,0.08)',
    'text-align:center',
    'position:relative',
  ].join(';') + '">' +
    '<div style="width:62px;height:62px;background:rgba(239,68,68,0.12);border:2px solid rgba(239,68,68,0.45);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:30px;">⚠️</div>' +
    '<h2 style="color:#fff;font-size:19px;font-weight:800;margin:0 0 10px;letter-spacing:-0.3px;line-height:1.25;">Extensão Desativada!</h2>' +
    '<p style="color:#a0a0b8;font-size:13.5px;line-height:1.65;margin:0 0 6px;">A extensão <strong style="color:#e2e2f0;">Lovable ∞</strong> foi desativada automaticamente.</p>' +
    '<p style="color:#a0a0b8;font-size:13.5px;line-height:1.65;margin:0 0 20px;">Se continuar agora, sua mensagem será enviada <strong style="color:#f87171;">diretamente para a Lovable</strong> e irá <strong style="color:#f87171;">gastar seus créditos</strong>.</p>' +
    '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.22);border-radius:12px;padding:11px 14px;margin-bottom:24px;">' +
      '<p style="color:#fca5a5;font-size:12px;margin:0;line-height:1.55;">💡 Recomendamos cancelar e atualizar a página. A extensão voltará a proteger seus créditos automaticamente.</p>' +
    '</div>' +
    '<button id="__ql_cw_reload__" style="display:block;width:100%;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:13px;padding:14px 20px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px;box-shadow:0 4px 18px rgba(22,163,74,0.35);letter-spacing:-0.2px;">✓ Cancelar e Atualizar Página</button>' +
    '<button id="__ql_cw_go__" style="display:block;width:100%;background:transparent;color:#f87171;border:1px solid rgba(239,68,68,0.35);border-radius:13px;padding:11px 20px;font-size:12.5px;font-weight:500;cursor:pointer;opacity:0.85;letter-spacing:0;">Continuar mesmo assim e gastar meus créditos</button>' +
  '</div>';

  document.body.appendChild(ov);
  _creditModal = ov;

  ov.querySelector('#__ql_cw_reload__').addEventListener('click', () => {
    // Não recarrega a página automaticamente: o usuário pode continuar no Lovable
    // sem perder o estado atual do projeto.
    try { ov.remove(); } catch(_) {}
    _creditModal = null;
    if (typeof onContinue === 'function') onContinue();
  });
  ov.querySelector('#__ql_cw_go__').addEventListener('click', () => {
    try { ov.remove(); } catch(_) {}
    _creditModal = null;
    if (typeof onContinue === 'function') onContinue();
  });
}

// Sync imediato + tentativas progressivas (cobre carregamento lento do Supabase)
(function() {
  function trySave() {
    try {
      const freshToken = readTokenFromLocalStorage();
      const pid = getProjectFromUrl();
      if (freshToken || pid) saveToStorage(freshToken, pid);
    } catch(e) {}
  }
  trySave();
  setTimeout(trySave, 1500);
  setTimeout(trySave, 3000);
  setTimeout(trySave, 5500);
})();

// ── Escudo: overlay visual que cobre SOMENTE o chat nativo do Lovable ────────
function _qlFindChatPanel() {
  // Só ativa em páginas de projeto já criado — nunca na homepage de criar projeto.
  // Homepage: lovable.dev/ ou lovable.dev/u/... (sem /projects/UUID na URL)
  // Projeto:  lovable.dev/projects/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const _href = window.location.pathname + window.location.search;
  if (!/\/projects\/[0-9a-fA-F-]{8,}/i.test(_href)) return null;

  // Tenta direto o form#chat-input (seletor estável da Lovable)
  const form = document.querySelector('form#chat-input');
  if (form) return form;

  // Fallback: sobe a partir do textarea "Ask Lovable..." procurando o form pai
  const inputs = document.querySelectorAll('textarea, [contenteditable]');
  for (const input of inputs) {
    const ph = input.getAttribute('placeholder') || '';
    if (/ask lovable|lovable/i.test(ph)) {
      let el = input.parentElement;
      while (el && el !== document.body) {
        if (el.tagName === 'FORM') return el;
        const r = el.getBoundingClientRect();
        if (r.height > 150) break;
        el = el.parentElement;
      }
      return input.parentElement;
    }
  }
  return null;
}

function _qlInjectShield() {
  if (document.getElementById('__ql_shield__')) return;

  const panel = _qlFindChatPanel();
  const el = document.createElement('div');
  el.id = '__ql_shield__';

  if (panel) {
    const r = panel.getBoundingClientRect();
    const capW = r.width;
    el.style.cssText =
      'position:fixed!important;' +
      'top:'    + r.top    + 'px!important;' +
      'left:'   + r.left   + 'px!important;' +
      'width:'  + capW     + 'px!important;' +
      'height:' + r.height + 'px!important;' +
      'background:rgba(10,10,20,0.92)!important;' +
      'z-index:2147483647!important;' +
      'display:flex!important;flex-direction:column!important;' +
      'align-items:center!important;justify-content:center!important;' +
      'gap:8px!important;pointer-events:all!important;cursor:not-allowed!important;' +
      'font-family:sans-serif!important;border-radius:0!important;';

    const ro = new ResizeObserver(() => {
      const rr = panel.getBoundingClientRect();
      el.style.top    = rr.top    + 'px';
      el.style.left   = rr.left   + 'px';
      el.style.width  = rr.width + 'px';
      el.style.height = rr.height + 'px';
    });
    ro.observe(panel);
    el._qlRO = ro;
  } else {
    el.style.cssText =
      'position:fixed!important;bottom:0!important;left:0!important;' +
      'width:340px!important;height:120px!important;' +
      'background:rgba(10,10,20,0.92)!important;' +
      'z-index:2147483647!important;' +
      'display:flex!important;flex-direction:column!important;' +
      'align-items:center!important;justify-content:center!important;' +
      'gap:12px!important;pointer-events:all!important;cursor:not-allowed!important;' +
      'font-family:sans-serif!important;';
  }

  el.innerHTML =
    '<div style="font-size:28px;line-height:1">🛡️</div>' +
    '<div style="color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em">ESCUDO ATIVO</div>' +
    '<div style="color:rgba(255,255,255,.5);font-size:10px;text-align:center;padding:0 12px">Chat nativo bloqueado · Desative pelo painel</div>';

  document.documentElement.appendChild(el);
}

function _qlRemoveShield() {
  const el = document.getElementById('__ql_shield__');
  if (el) {
    if (el._qlRO) el._qlRO.disconnect();
    el.remove();
  }
}

// Restaura escudo ao carregar a página (caso já estivesse ativo)
try {
  chrome.storage.local.get(['ql_shield_active'], function(r) {
    if (r && r.ql_shield_active) _qlInjectShield();
  });
} catch(e) {}

// ── Plan-Approval Relay: recebe mensagens do pageHook.js (MAIN world) e repassa ao background ──
// pageHook.js detecta plan_approval events no SSE nativo do Lovable e posta window.postMessage.
// Este listener recebe, valida e encaminha ao background.js para auto-aprovação.
(function() {
  var _relayedPlanIds = {}; // deduplica no lado do content script também

  window.addEventListener('message', function(event) {
    if (event.source !== window || !event.data) return;

    // ── Novo: plano detectado no SSE → salva no storage para aprovação por teclado ──
    // Quando o usuário digita "approve" na extensão, handleSend() consulta ql_pending_plan
    if (event.data.type === '__QL_PLAN_DETECTED__') {
      var _pId      = event.data.id      || '';
      var _pContent = event.data.content || '';
      if (_pId && _pContent) {
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ ql_pending_plan: {
              id:      _pId,
              content: _pContent,
              ts:      event.data.ts || Date.now()
            }});
            console.log('[Content] 📌 Plano pendente salvo no storage | id:', _pId.slice(0, 12));
          }
        } catch(e) {}
      }
      return;
    }

    // ── Guard: envio direto bloqueado pelo pageHook → mostra modal de créditos ──
    if (event.data.type === '__QL_NATIVE_SEND_BLOCKED__') {
      _showCreditWarningModal(function() {
        // Usuário escolheu "Continuar e gastar créditos": desbloqueia guard UMA VEZ
        // e re-clica o botão de envio para a requisição passar
        try { window.postMessage({ type: '__QL_SET_GUARD__', block: false }, '*'); } catch(_) {}
        _creditWarningAllowed = true;
        try {
          var _sb = findSendButton(_form);
          if (_sb) _sb.click();
        } catch(_) {}
        setTimeout(function() {
          _creditWarningAllowed = false;
          // Re-ativa o guard se extensão ainda estiver desativada
          if (!_active) {
            try { window.postMessage({ type: '__QL_SET_GUARD__', block: true }, '*'); } catch(_) {}
          }
        }, 2500);
      });
      return;
    }

    if (event.data.type !== '__QL_PLAN_APPROVAL__') return;

    var content = event.data.content || '';
    var id      = event.data.id || event.data.tool_call_event_id || '';

    if (!content || !id) return;
    if (_relayedPlanIds[id]) return; // já foi enviado
    _relayedPlanIds[id] = true;
    setTimeout(function() { delete _relayedPlanIds[id]; }, 90000);

    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({
        action:  'planApproval',
        content: content,
        id:      id,
        tabId:   _myTabId,
      }, function(resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok) {
          console.log('[Content] ✅ Plan auto-aprovado! id:', id);
        } else {
          console.warn('[Content] ⚠ Plan approval falhou:', resp && resp.error);
        }
      });
    } catch(e) {}
  });
})();

// ── Captura headers de sessão do pageHook.js → salva no storage ──────────────
// pageHook.js intercepta requests da Lovable nativa e captura x-browser-session-id
// e x-client-git-sha. Esses valores são usados pelo edge function para autenticar
// requests de forma mais autêntica junto à API da Lovable.
(function() {
  window.addEventListener('message', function(ev) {
    if (ev.source !== window || !ev.data) return;

    if (ev.data.type === '__QL_SESSION_HEADERS__') {
      try {
        var updates = {};
        if (ev.data.sessionId) updates.ql_browser_session_id = ev.data.sessionId;
        if (ev.data.gitSha)    updates.ql_git_sha            = ev.data.gitSha;
        if (Object.keys(updates).length && typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set(updates);
        }
      } catch(_) {}
    }

    // Payload inicial sintético — só armazena se lovable_chat_payloads ainda estiver vazio
    // Garante que o widget sempre tem campos reais (viewport, current_page, thread_id, etc.)
    // mesmo antes do usuário enviar qualquer mensagem pelo chat nativo do Lovable.
    if (ev.data.type === '__QL_INIT_PAYLOAD__' && ev.data.payload) {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage) return;
        chrome.storage.local.get({ lovable_chat_payloads: [] }, function(stored) {
          var arr = stored.lovable_chat_payloads || [];
          if (arr.length === 0) {
            arr.push({ timestamp: Date.now(), url: '', body: ev.data.payload, synthetic: true });
            chrome.storage.local.set({ lovable_chat_payloads: arr });
            console.log('[QL content] payload sintético inicial armazenado | page:', ev.data.payload.current_page, '| viewport:', ev.data.payload.current_viewport_width + 'x' + ev.data.payload.current_viewport_height);
          }
        });
      } catch(_) {}
    }
  });
})();

// ── Relay chave de licença → pageHook.js (MAIN world) ────────────────────────
function _relayFixKey() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get(['ql_ck', 'ql_hw_fp_v2'], function(r) {
      try {
        window.postMessage({
          type: '__QL_FIX_KEY__',
          key:  (r && r.ql_ck)       || null,
          hwid: (r && r.ql_hw_fp_v2) || '',
        }, '*');
      } catch(_) {}
    });
  } catch(_) {}
}
// Relay inicial (cobre o caso mais comum: extensão já tinha licença ativa)
_relayFixKey();
// Relay atrasado — cobre carregamento lento do storage na primeira injeção
setTimeout(_relayFixKey, 1500);
setTimeout(_relayFixKey, 4000);

// ── Relay ql_display_msg → pageHook.js ───────────────────────────────────────
// Quando sidepanel.js salva a mensagem limpa do usuário, content.js detecta a mudança
// e relaia ao pageHook.js (mundo MAIN) via postMessage.
// pageHook.js usa essa mensagem como display text no chat do Lovable.
try {
  chrome.storage.onChanged.addListener(function(changes) {
    if (changes.ql_display_msg && changes.ql_display_msg.newValue) {
      try {
        window.postMessage({
          type: '__QL_LAST_MSG__',
          msg: changes.ql_display_msg.newValue
        }, '*');
      } catch(_) {}
    }
    // Re-relaia a chave quando ql_ck ou o status da licença mudar (login/logout/renovação)
    if (changes.ql_ck || changes.ql_license_valid) {
      _relayFixKey();
    }
  });
} catch(_) {}

// Listener de mensagens do background/sidepanel
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'sp_improve_prompt' && msg.text) {
    (async () => {
      try {
        const online = await _qlImproveOnline(msg.text);
        sendResponse({ improved: (online !== null) ? online : _qlImproveOffline(msg.text) });
      } catch(_) {
        sendResponse({ improved: _qlImproveOffline(msg.text) });
      }
    })();
    return true; // mantém canal aberto para resposta assíncrona
  }

  if (msg && msg.action === "toggleShield") {
    if (msg.active) _qlInjectShield(); else _qlRemoveShield();
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.action === "doRequestLatestToken") {
    // Lê token do localStorage/sessionStorage e aguarda a gravação no storage
    // antes de chamar sendResponse — elimina race condition com o sidepanel
    const freshToken = readTokenFromLocalStorage();
    const pid = getProjectFromUrl();
    if (freshToken || pid) {
      try {
        const updates = {};
        const clean = freshToken ? freshToken.replace(/^Bearer\s+/i, "").trim() : null;
        if (clean) {
          updates.lovable_token = clean;
          if (_myTabId != null) updates[`lov_tok_${_myTabId}`] = clean;
        }
        if (pid) {
          updates.lovable_projectId = pid;
          if (_myTabId != null) updates[`lov_pid_${_myTabId}`] = pid;
        }
        if (Object.keys(updates).length) {
          chrome.storage.local.set(updates, function() {
            sendResponse({ ok: true }); // responde APÓS a gravação ser confirmada
          });
          return true; // mantém canal aberto para resposta assíncrona
        }
      } catch(e) {}
    }
    sendResponse({ ok: true });
    return false;
  }

  // background.js (action:'sendMessage', usado pelo widget de chat nativo)
  // pede o token MAIS FRESCO possível direto da aba antes de cair pro valor
  // em cache no chrome.storage.local — esse handler nunca existiu, então essa
  // tentativa sempre falhava silenciosamente (chrome.runtime.lastError) e o
  // envio ficava só com o storage, que pode estar velho se a aba passou um
  // tempo em background (timers de sync throttled) e a sessão rotacionou.
  if (msg && msg.action === "getToken") {
    const freshToken = readTokenFromLocalStorage();
    const pid = getProjectFromUrl();
    sendResponse({ token: freshToken || null, projectId: pid || null });
    return false;
  }

  // ── Desloga da conta Lovable atual (Switch de Contas) ───────────────────
  // Remove o(s) token(s) de sessão do Supabase Auth (mesma chave usada pelo
  // readTokenFromLocalStorage) de localStorage/sessionStorage e recarrega a
  // página — o app do Lovable, sem sessão válida, cai na tela de login.
  if (msg && msg.action === "logoutLovable") {
    (async function () {
      try {
        [localStorage, sessionStorage].forEach(function (store) {
          var toRemove = [];
          for (var i = 0; i < store.length; i++) {
            var key = store.key(i);
            if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) toRemove.push(key);
          }
          toRemove.forEach(function (k) { store.removeItem(k); });
        });
      } catch (e) {}
      // O Lovable usa Firebase Auth (JWT tem iss:securetoken.google.com), que por
      // padrão persiste a sessão no IndexedDB — sobrevive a limpar localStorage e
      // cookies, e reidrata a sessão sozinho ao recarregar. Precisa apagar aqui também.
      try {
        if (indexedDB.databases) {
          var dbs = await indexedDB.databases();
          for (var j = 0; j < dbs.length; j++) {
            var name = dbs[j] && dbs[j].name;
            if (name && /firebase/i.test(name)) {
              try { indexedDB.deleteDatabase(name); } catch (e2) {}
            }
          }
        } else {
          try { indexedDB.deleteDatabase("firebaseLocalStorageDb"); } catch (e3) {}
        }
      } catch (e4) {}
      // Não redireciona para login: o painel funciona em modo local e não
      // deve interromper a aba do usuário.
      sendResponse({ ok: true, redirected: false });
    })();
    return true;
  }

  // ── Injeta nova sessão Supabase sem recarregar a página ─────────────────────
  if (msg && msg.action === "setLovableSession") {
    (async function () {
      try {
        var session = msg.session || {};
        var FB_API_KEY = "AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw";
        var fbIdbKey = "firebase:authUser:" + FB_API_KEY + ":[DEFAULT]";

        // 1. Encerra sessão do servidor Lovable (invalida o cookie de sessão atual)
        try {
          await fetch("/_serverFn/83ad366b0469b60b96159f7f30ace5c7fae789552207455765f11c0d5a8da65c", {
            method: "POST", credentials: "include"
          });
        } catch(e) {}

        // 2. Limpa sessao antiga do localStorage
        [localStorage, sessionStorage].forEach(function (store) {
          var toRemove = [];
          for (var i = 0; i < store.length; i++) {
            var key = store.key(i);
            if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) toRemove.push(key);
          }
          toRemove.forEach(function (k) { store.removeItem(k); });
        });

        // 3. Escreve no Firebase IndexedDB (firebaseLocalStorageDb) com dados da nova conta
        var u = session.user || {};
        var fbUser = {
          uid: u.id || "",
          email: u.email || "",
          emailVerified: true,
          displayName: (u.user_metadata && u.user_metadata.full_name) || u.email || "",
          isAnonymous: false,
          providerData: [{ uid: u.email || "", displayName: (u.user_metadata && u.user_metadata.full_name) || "", photoURL: null, email: u.email || "", phoneNumber: null, providerId: "password" }],
          stsTokenManager: {
            refreshToken: session.refresh_token || "",
            accessToken: session.access_token || "",
            expirationTime: (session.expires_at ? session.expires_at * 1000 : Date.now() + 3600000)
          },
          lastLoginAt: String(Date.now()),
          createdAt: String(Date.now()),
          multiFactor: { enrolledFactors: [] },
          apiKey: FB_API_KEY,
          appName: "[DEFAULT]"
        };
        await new Promise(function(resolve) {
          var req = indexedDB.open("firebaseLocalStorageDb", 1);
          req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains("firebaseLocalStorage")) {
              db.createObjectStore("firebaseLocalStorage", { keyPath: "fbase_key" });
            }
          };
          req.onsuccess = function(e) {
            var db = e.target.result;
            try {
              var tx = db.transaction(["firebaseLocalStorage"], "readwrite");
              tx.objectStore("firebaseLocalStorage").put({ fbase_key: fbIdbKey, value: fbUser });
              tx.oncomplete = function() { db.close(); resolve(); };
              tx.onerror = function() { db.close(); resolve(); };
            } catch(ex) { resolve(); }
          };
          req.onerror = function() { resolve(); };
        });
      } catch (e) {}
      // A sessão foi gravada sem forçar reload; recarregar aqui causava
      // ciclos de atualização quando a extensão tentava sincronizar a aba.
      sendResponse({ ok: true, reloaded: false });
    })();
    return true;
  }

  // ── Clica no botão Approve/Submit nativo do Lovable ─────────────────────────
  // Usado pelo sidepanel quando o usuário digita "approve" mas não há ql_pending_plan
  // (plano gerado em sessão anterior / antes da extensão capturar o SSE)
  if (msg && msg.action === "clickApproveButton") {
    var _clicked = false;
    try {
      // Busca botão com texto "Approve" ou "Submit" (data-button é o primitivo do Lovable)
      var _btns = document.querySelectorAll('[data-button], button');
      for (var _bi = 0; _bi < _btns.length; _bi++) {
        var _btnTxt = (_btns[_bi].textContent || '').replace(/\s+/g, ' ').trim();
        if (/^(approve|submit)$/i.test(_btnTxt)) {
          console.log('[Content] 🖱️ Clicando programaticamente em:', _btnTxt);
          _btns[_bi].click();
          _clicked = true;
          break;
        }
      }
    } catch(e) { console.warn('[Content] clickApproveButton erro:', e); }
    sendResponse({ ok: _clicked, found: _clicked });
    return false;
  }

  // Resposta genérica para outros eventos (evita "receiving end does not exist")
  sendResponse({ status: "ok" });
  return false;
});

// ── Rebrand: substitui labels do Lovable por "Lovable ∞" no DOM ──────────────
(function() {
  const PATTERNS = [
    /^Fix\s+error$/i,
    /^Fix\s+Error$/i,
    /^Visual\s+edit$/i,
  ];
  const REPLACEMENT = 'Lovable ∞';

  const _seenNodes = new WeakSet();
  let _mods = 0, _windowStart = Date.now(), _paused = false;

  // Oculta todos os irmãos do label "Lovable ∞" para que o balão mostre somente o label.
  // Verifica tanto irmãos depois QUANTO antes do label (o body pode vir em qualquer ordem).
  function _hideMessageBody(textNode) {
    try {
      let el = textNode.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!el || el === document.body || el === document.documentElement) return;
        const parent = el.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) return;
        const kids = Array.from(parent.children);
        if (kids.length >= 2) {
          const myIdx = kids.indexOf(el);
          // Irmãos depois do label
          const after = kids.slice(myIdx + 1);
          // Irmãos antes do label — oculta apenas os que claramente são corpo de mensagem
          // (altura > 30px ou texto > 40 chars) para não esconder ícones/badges pequenos
          const before = kids.slice(0, myIdx).filter(sib => {
            try {
              const r = sib.getBoundingClientRect();
              if (r.height > 30) return true;
              if ((sib.textContent || '').trim().length > 40) return true;
            } catch(_) {}
            return false;
          });
          const toHide = [...after, ...before];
          if (toHide.length > 0) {
            toHide.forEach(sib => sib.style.setProperty('display', 'none', 'important'));
            return;
          }
        }
        el = parent;
      }
    } catch(_) {}
  }

  function tryReplace(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    if (_seenNodes.has(node)) return;
    if (_paused) return;
    const txt = (node.textContent || '').trim();
    if (!txt) return;
    if (txt === REPLACEMENT) { _seenNodes.add(node); return; }
    for (const re of PATTERNS) {
      if (re.test(txt)) {
        const now = Date.now();
        if (now - _windowStart > 1000) { _windowStart = now; _mods = 0; }
        _mods++;
        if (_mods > 30) {
          _paused = true;
          setTimeout(() => { _paused = false; _mods = 0; }, 3000);
          return;
        }
        _seenNodes.add(node);
        const leading  = node.textContent.match(/^\s*/)[0];
        const trailing = node.textContent.match(/\s*$/)[0];
        node.textContent = leading + REPLACEMENT + trailing;
        _hideMessageBody(node); // ← oculta corpo da mensagem, exibe só "Lovable ∞"
        return;
      }
    }
  }

  function walkAndReplace(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) tryReplace(n);
  }

  function start() {
    walkAndReplace(document.body);
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') { tryReplace(m.target); continue; }
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) tryReplace(node);
          else if (node.nodeType === Node.ELEMENT_NODE) walkAndReplace(node);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();

// ── Botão flutuante: liga/desliga o bypass do chat nativo ────────────────────
// Quando ATIVO: cobrimos o botão de enviar nativo (form#chat-input) com um
// overlay transparente nosso, posicionado exatamente por cima. O clique nunca
// chega ao botão real — o fetch nativo nunca é disparado, então não há erro de
// rede nem quebra do preview. Capturamos o texto do textarea + thumbnails de
// anexo já visíveis no DOM, e enviamos via background.js (action 'sendMessage').
(function() {
  const STORAGE_KEY = 'ql_native_bypass_active';
  const POS_KEY      = 'ql_widget_pos';
  let _active   = false;
  let _form     = null;
  let _btn      = null;
  let _dot      = null;
  let _banner   = null;
  let _chips    = null;
  let _overlay  = null;
  let _dropHint = null;
  let _dragCounter = 0;
  let _sending  = false;
  let _dragged  = false; // true após o usuário arrastar manualmente — para de auto-ancorar
  let _formResizeObs    = null;
  let _overlayResizeObs = null;
  let _overlayRAF       = null;
  let _pendingAttachments = []; // anexos já enviados ao NOSSO storage, aguardando o próximo doSend()
  let _teardown = false; // true depois que detectamos contexto inválido — para tudo

  // Detecta extensão recarregada/desinstalada enquanto a página já estava aberta
  // (chrome.runtime.id lança "Extension context invalidated" nesse caso).
  // Usado como guarda no topo de todo callback periódico/assíncrono.
  function isExtensionAlive() {
    try { return !_teardown && !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (_) { return false; }
  }

  // Remove toda a UI injetada e marca o widget como morto — chamado na
  // primeira vez que detectamos contexto inválido, pra não ficar tentando
  // chamar chrome.* (e gerando "Uncaught Error" repetido no log da extensão).
  function teardownWidget() {
    if (_teardown) return;
    _teardown = true;
    _active = false;
    try { stopOverlayLoop(); } catch (_) {}
    try { _btn && _btn.remove(); } catch (_) {}
    try { _banner && _banner.remove(); } catch (_) {}
    try { _chips && _chips.remove(); } catch (_) {}
    try { _overlay && _overlay.remove(); } catch (_) {}
    try { if (_form) highlightForm(false); } catch (_) {}
    try { document.removeEventListener('keydown', onDocKeydown, true); } catch (_) {}
    try { document.removeEventListener('click', onDocClickCapture, true); } catch (_) {}
    try { document.removeEventListener('paste', onDocPaste, true); } catch (_) {}
    try { document.removeEventListener('dragenter', onDocDragEnter, true); } catch (_) {}
    try { document.removeEventListener('dragover', onDocDragOver, true); } catch (_) {}
    try { document.removeEventListener('dragleave', onDocDragLeave, true); } catch (_) {}
    try { document.removeEventListener('drop', onDocDrop, true); } catch (_) {}
    try { removeDropHint(); } catch (_) {}
  }

  // ── Wrappers seguros para TODA chamada chrome.* do widget ────────────────
  // Cada um checa isExtensionAlive() antes E envolve em try/catch — cobre tanto
  // o caso "já sei que invalidou" quanto o caso "invalidou nesse exato instante,
  // entre o check e a chamada" (race rara, mas o try/catch resolve os dois).
  function safeGet(keys, cb) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    try {
      chrome.storage.local.get(keys, (r) => {
        if (!isExtensionAlive()) { teardownWidget(); return; }
        try { cb(r); } catch (_) { teardownWidget(); }
      });
    } catch (_) { teardownWidget(); }
  }

  function safeSet(items) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    try { chrome.storage.local.set(items); } catch (_) { teardownWidget(); }
  }

  function safeRemove(keys) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    try { chrome.storage.local.remove(keys); } catch (_) { teardownWidget(); }
  }

  function safeSendMessage(msg, cb) {
    if (!isExtensionAlive()) { teardownWidget(); if (cb) cb(null); return; }
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        try { void chrome.runtime.lastError; } catch (_) {}
        if (cb) cb(r);
      });
    } catch (_) { teardownWidget(); if (cb) cb(null); }
  }

  function safeGetURL(path) {
    if (!isExtensionAlive()) { teardownWidget(); return ''; }
    try { return chrome.runtime.getURL(path); }
    catch (_) { teardownWidget(); return ''; }
  }

  // ── Gate de licença: o botão só existe se houver licença ATIVA e não expirada ──
  // Sem isso, qualquer pessoa com a extensão instalada (sem nunca logar com uma
  // licença) conseguiria usar o bypass nativo, já que ele roda só no content
  // script da página — independente do sidepanel estar aberto/logado.
  const LICENSE_KEYS = ['ql_license_valid', 'ql_lk', 'ql_ck', 'ql_expires_at', 'ql_license_status'];

  function hasValidLicense(s) {
    if (!s || !s.ql_license_valid || !s.ql_lk || !s.ql_ck) return false;
    if (s.ql_expires_at) {
      const exp = new Date(s.ql_expires_at).getTime();
      if (!isNaN(exp) && exp <= Date.now()) return false;
    }
    if (s.ql_license_status && /block|expir|invalid/i.test(s.ql_license_status)) return false;
    return true;
  }

  // Limpa a sessão local — mesmas chaves que o forceLogout() do sidepanel.js
  // remove. Chamado quando o SERVIDOR confirma que a licença está inválida/
  // bloqueada/expirada (não para falhas transitórias do validador).
  function forceLogoutFromWidget() {
    safeRemove([
      'ql_license_valid', 'ql_lk', 'ql_session_id', 'ql_user_name',
      'ql_expires_at', 'ql_activated_at', 'ql_license_status', 'ql_ed', 'ql_ck',
    ]);
  }

  // O envio sai do background direto pro api.lovable.dev, então o React do
  // Lovable nunca fica sabendo que uma mensagem entrou — a lista de chat fica
  // parada. Estes eventos são os que o React Query escuta para revalidar
  // (focusManager/onlineManager); nenhum deles checa isTrusted, então o
  // disparo sintético funciona e evita ter que recarregar a aba inteira.
  function refreshChatAfterSend() {
    const cutucar = () => {
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('online'));
      } catch (_) {}
    };
    cutucar();
    // O 202 só diz "started" — a mensagem aparece na trajetória um instante
    // depois. Duas cutucadas cobrem esse atraso sem recarregar nada.
    setTimeout(cutucar, 1500);
  }

  function showToast(text, ok, durationMs) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText =
      'position:fixed!important;bottom:88px!important;right:24px!important;' +
      'background:' + (ok ? '#16a34a' : '#dc2626') + '!important;color:#fff!important;' +
      'padding:10px 16px!important;border-radius:10px!important;font:600 13px sans-serif!important;' +
      'z-index:2147483647!important;box-shadow:0 4px 16px rgba(0,0,0,.3)!important;' +
      'opacity:0!important;transition:opacity .25s!important;pointer-events:none!important;max-width:280px!important;';
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, durationMs || 3200);
  }

  function _ensurePulseStyle() {
    if (document.getElementById('__ql_pulse_style__')) return;
    const s = document.createElement('style');
    s.id = '__ql_pulse_style__';
    s.textContent =
      '@keyframes __qlPulse{' +
        '0%,100%{box-shadow:0 0 0 2px rgba(124,58,237,0.85),0 0 10px rgba(124,58,237,0.45)}' +
        '50%{box-shadow:0 0 0 3px rgba(167,139,250,1),0 0 22px rgba(124,58,237,0.75),0 0 44px rgba(124,58,237,0.25)}' +
      '}';
    (document.head || document.documentElement).appendChild(s);
  }

  function highlightForm(on) {
    if (!_form) return;
    if (on) {
      _ensurePulseStyle();
      _form.style.setProperty('outline', 'none', 'important');
      _form.style.setProperty('border-radius', '12px', 'important');
      _form.style.setProperty('animation', '__qlPulse 2s ease-in-out infinite', 'important');
    } else {
      _form.style.removeProperty('animation');
      _form.style.removeProperty('border-radius');
      _form.style.removeProperty('outline');
      _form.style.removeProperty('outline-offset');
    }
  }

  // ── Banner de status acima do textarea ────────────────────────────────────
  // Discreto: sem fundo sólido, só texto colorido com glow neon na borda.
  function createStatusBanner() {
    if (_banner) return;
    const b = document.createElement('div');
    b.id = '__ql_nb_banner__';
    b.style.cssText =
      'position:fixed!important;z-index:2147483647!important;box-sizing:border-box!important;' +
      'padding:2px 9px!important;border-radius:6px!important;font:700 10px sans-serif!important;' +
      'text-align:center!important;pointer-events:none!important;white-space:nowrap!important;' +
      'overflow:hidden!important;text-overflow:ellipsis!important;width:fit-content!important;' +
      'background:rgba(10,10,15,.55)!important;backdrop-filter:blur(2px)!important;';
    document.documentElement.appendChild(b);
    _banner = b;
  }

  function removeStatusBanner() {
    if (_banner) { _banner.remove(); _banner = null; }
  }

  function updateBannerText(v) {
    if (!_banner) return;
    const color = v ? '#22c55e' : '#ef4444';
    const glow  = v ? 'rgba(34,197,94,.85)' : 'rgba(239,68,68,.85)';
    _banner.textContent = v
      ? '✓ Lovable ∞ Ativado no Chat nativo!'
      : '⚠ Lovable ∞ desativado — créditos serão consumidos!';
    _banner.style.setProperty('color', color, 'important');
    _banner.style.setProperty('border', '1px solid ' + color, 'important');
    _banner.style.setProperty('box-shadow', '0 0 6px ' + glow + ', 0 0 2px ' + glow + ' inset', 'important');
    _banner.style.setProperty('text-shadow', '0 0 6px ' + glow, 'important');
  }

  // Esconde o banner enquanto qualquer menu/dropdown nativo estiver aberto
  // (ex: o "+" → Settings/Attach/etc) — evita cobrir o popup, já que nosso
  // z-index é mais alto que o do Lovable.
  function isNativeMenuOpen() {
    // Só considera "aberto" se o menu/dialog estiver REALMENTE visível (com
    // tamanho na tela). Apps React (como o Lovable) costumam manter elementos
    // [role="dialog"] montados porém ocultos — checar só a presença no DOM
    // escondia nossos chips/banner de anexo permanentemente ("upload funciona
    // mas o arquivo não aparece").
    const els = document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]');
    for (const el of els) {
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const st = getComputedStyle(el);
          if (st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0') return true;
        }
      } catch (_) {}
    }
    return false;
  }

  // Empilha acima dos chips de anexo (quando existem) em vez de um offset fixo
  // — evita o banner sobrepor a thumbnail quando há anexo pendente.
  function positionBanner() {
    if (!_banner || !_form) return;
    try {
      if (isNativeMenuOpen()) {
        _banner.style.setProperty('display', 'none', 'important');
        return;
      }
      _banner.style.setProperty('display', 'block', 'important');
      const ta = findTextarea(_form);
      const r  = ta ? ta.getBoundingClientRect() : _form.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;

      let baseTop = r.top - 22; // padrão: direto acima do textarea
      if (_chips && _pendingAttachments.length > 0) {
        const chipsRect = _chips.getBoundingClientRect();
        if (chipsRect.height > 0) baseTop = chipsRect.top - 22; // empilha acima dos chips
      }
      _banner.style.top  = Math.max(4, baseTop) + 'px';
      _banner.style.left = r.left + 'px';
    } catch (_) {}
  }

  // ── Chips de anexo pendente — mostra thumbnail/ícone + nome + botão remover,
  // no estilo do preview nativo do Lovable, acima do banner de status.
  function createAttachmentChips() {
    if (_chips) return;
    if (!document.getElementById('__ql_nb_spin_style__')) {
      const s = document.createElement('style');
      s.id = '__ql_nb_spin_style__';
      s.textContent = '@keyframes __ql_spin { to { transform: rotate(360deg); } }' +
        '@keyframes __ql_pulse { 0%,100%{box-shadow:0 0 0 3px rgba(34,197,94,.35),0 4px 16px rgba(0,0,0,.5)} 50%{box-shadow:0 0 0 7px rgba(34,197,94,.55),0 0 22px rgba(34,197,94,.4),0 4px 16px rgba(0,0,0,.5)} }';
      document.documentElement.appendChild(s);
    }
    const c = document.createElement('div');
    c.id = '__ql_nb_chips__';
    c.style.cssText =
      'position:fixed!important;z-index:2147483647!important;display:flex!important;' +
      'gap:8px!important;flex-wrap:wrap!important;max-width:360px!important;';
    document.documentElement.appendChild(c);
    _chips = c;
  }

  function hasUploadingAttachments() {
    return _pendingAttachments.some(a => a.uploading);
  }

  function removeAttachmentChips() {
    if (_chips) { _chips.remove(); _chips = null; }
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Popup de preview — nome/formato/tamanho, e a imagem grande quando for imagem
  // (mesma ideia do preview nativo do Lovable ao clicar num anexo).
  function showAttachmentPreview(att) {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed!important;inset:0!important;background:rgba(0,0,0,.75)!important;' +
      'z-index:2147483647!important;display:flex!important;align-items:center!important;' +
      'justify-content:center!important;font-family:sans-serif!important;cursor:pointer!important;';

    const box = document.createElement('div');
    box.style.cssText =
      'background:#18181b!important;border:1px solid rgba(255,255,255,.15)!important;' +
      'border-radius:14px!important;padding:18px!important;max-width:90vw!important;' +
      'max-height:90vh!important;overflow:auto!important;cursor:default!important;' +
      'box-shadow:0 12px 48px rgba(0,0,0,.6)!important;display:flex!important;' +
      'flex-direction:column!important;gap:12px!important;align-items:center!important;';
    box.addEventListener('click', (e) => e.stopPropagation());

    const isImg = (att.mime_type || '').startsWith('image/');
    if (isImg && att.download_url) {
      const img = document.createElement('img');
      img.src = att.download_url;
      img.style.cssText = 'max-width:80vw!important;max-height:65vh!important;border-radius:8px!important;display:block!important;';
      box.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.textContent = '📄';
      icon.style.cssText = 'font-size:64px!important;text-align:center!important;';
      box.appendChild(icon);
    }

    const ext = (att.file_name || '').includes('.') ? att.file_name.split('.').pop().toUpperCase() : '?';
    const nameEl = document.createElement('div');
    nameEl.textContent = att.file_name || 'arquivo';
    nameEl.style.cssText = 'color:#fff!important;font-weight:700!important;font-size:13px!important;text-align:center!important;word-break:break-all!important;';
    box.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.textContent = 'Formato: ' + ext + (att.file_size ? ' · ' + att.file_size : '');
    metaEl.style.cssText = 'color:rgba(255,255,255,.55)!important;font-size:12px!important;text-align:center!important;';
    box.appendChild(metaEl);

    overlay.appendChild(box);
    overlay.addEventListener('click', () => overlay.remove());
    document.documentElement.appendChild(overlay);
  }

  // Chip compacto: só thumbnail/ícone (nome aparece no tooltip ao passar o
  // mouse — via atributo title nativo), clique abre o preview em popup.
  // Enquanto uploading=true: mostra a preview LOCAL (blob, instantânea) com
  // um spinner por cima — só troca pra URL real quando o upload termina.
  function renderAttachmentChips() {
    if (!_chips) return;
    _chips.innerHTML = '';
    _pendingAttachments.forEach((att, idx) => {
      const chip = document.createElement('div');
      chip.title = att.failed ? (att.file_name + ' — falha no upload') : (att.file_name || 'arquivo');
      const borderColor = att.failed ? '#dc2626' : 'rgba(255,255,255,.18)';
      chip.style.cssText =
        'position:relative!important;display:flex!important;align-items:center!important;' +
        'justify-content:center!important;width:46px!important;height:46px!important;' +
        'background:rgba(20,20,25,.92)!important;border:1.5px solid ' + borderColor + '!important;' +
        'border-radius:10px!important;cursor:pointer!important;pointer-events:auto!important;' +
        'box-shadow:0 2px 6px rgba(0,0,0,.3)!important;overflow:hidden!important;';

      const isImg = (att.mime_type || '').startsWith('image/');
      const previewSrc = att.local_preview || att.download_url;
      if (isImg && previewSrc) {
        const img = document.createElement('img');
        img.src = previewSrc;
        img.style.cssText = 'width:100%!important;height:100%!important;object-fit:cover!important;';
        chip.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.textContent = att.failed ? '⚠' : '📄';
        icon.style.cssText = 'font-size:22px!important;';
        chip.appendChild(icon);
      }

      if (att.uploading) {
        const spinnerWrap = document.createElement('div');
        spinnerWrap.style.cssText =
          'position:absolute!important;inset:0!important;background:rgba(0,0,0,.55)!important;' +
          'display:flex!important;align-items:center!important;justify-content:center!important;';
        const spinner = document.createElement('div');
        spinner.style.cssText =
          'width:18px!important;height:18px!important;border-radius:50%!important;' +
          'border:2px solid rgba(255,255,255,.3)!important;border-top-color:#fff!important;' +
          'animation:__ql_spin .8s linear infinite!important;';
        spinnerWrap.appendChild(spinner);
        chip.appendChild(spinnerWrap);
      }

      chip.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (att.uploading) { showToast('⏳ Ainda enviando...', false); return; }
        if (att.failed) { showToast('⚠ Falha no upload — remova e tente de novo.', false); return; }
        showAttachmentPreview(att);
      });

      const rm = document.createElement('span');
      rm.textContent = '✕';
      rm.title = 'Remover';
      rm.style.cssText =
        'position:absolute!important;top:-7px!important;right:-7px!important;' +
        'width:20px!important;height:20px!important;border-radius:50%!important;' +
        'background:#dc2626!important;color:#fff!important;font-size:12px!important;font-weight:700!important;' +
        'display:flex!important;align-items:center!important;justify-content:center!important;' +
        'cursor:pointer!important;line-height:1!important;border:2px solid #18181b!important;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.4)!important;';
      rm.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (att.local_preview) { try { URL.revokeObjectURL(att.local_preview); } catch (_) {} }
        _pendingAttachments.splice(idx, 1);
        renderAttachmentChips();
        positionAttachmentChips();
        positionBanner();
      });
      chip.appendChild(rm);

      _chips.appendChild(chip);
    });
  }

  function positionAttachmentChips() {
    if (!_chips || !_form) return;
    try {
      if (isNativeMenuOpen() || _pendingAttachments.length === 0) {
        _chips.style.setProperty('display', 'none', 'important');
        return;
      }
      _chips.style.setProperty('display', 'flex', 'important');
      const ta = findTextarea(_form);
      const r  = ta ? ta.getBoundingClientRect() : _form.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      // Mede a altura REAL renderizada (pode ter mais de uma linha com várias chips)
      const chipsHeight = _chips.getBoundingClientRect().height || 26;
      _chips.style.top  = Math.max(4, r.top - chipsHeight - 6) + 'px';
      _chips.style.left = r.left + 'px';
    } catch (_) {}
  }

  // Ancora o botão perto do chat nativo (canto superior-direito do form, um
  // pouco acima da caixa de texto) — só enquanto o usuário não arrastou manualmente.
  function positionNearForm() {
    positionAttachmentChips(); // primeiro: mais perto do textarea
    positionBanner();          // empilha acima dos chips, se houver
    if (_dropHint) positionDropHint();
    if (_dragged || !_btn || !_form) return;
    try {
      const r = _form.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return;
      const vw = window.innerWidth  || document.documentElement.clientWidth  || 360;
      const vh = window.innerHeight || document.documentElement.clientHeight || 640;
      // Clampeia dentro do viewport — no mobile o form pode ter r.right > vw
      // (container não responsivo) ou r.top - 60 > vh (teclado empurrou o form
      // para fora), colocando o botão fora da tela.
      const topRaw  = r.top - 60;
      const leftRaw = Math.min(r.right, vw) - 52;
      _btn.style.top    = Math.min(vh - 52, Math.max(8, topRaw))  + 'px';
      _btn.style.left   = Math.min(vw - 52, Math.max(8, leftRaw)) + 'px';
      _btn.style.right  = 'auto';
      _btn.style.bottom = 'auto';
    } catch (_) {}
  }

  function findTextarea(form) {
    if (!form) return null;
    const inputs = form.querySelectorAll('textarea, [contenteditable]');
    for (const input of inputs) {
      const ph = input.getAttribute('placeholder') || '';
      if (/ask lovable|lovable/i.test(ph)) return input;
    }
    return inputs[0] || null;
  }

  // Lê o seletor nativo "Build / Plan" — quando o usuário escolhe Plan, o
  // Lovable só "discute antes de construir" se o texto enviado indicar isso.
  // Como nosso bypass não reaproveita o estado interno do React, simulamos
  // isso prefixando a mensagem quando o modo Plan estiver selecionado.
  function getNativeMode(form) {
    if (!form) return 'build';
    const btns = form.querySelectorAll('button');
    for (const b of btns) {
      const txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^plan$/i.test(txt))  return 'plan';
      if (/^build$/i.test(txt)) return 'build';
    }
    return 'build';
  }

  // Identifica o botão de ENVIAR — nunca o de microfone/anexo, que ficariam
  // bloqueados (cobertos pelo overlay) se a heurística escolhesse errado.
  // 1) aria-label/title explícito ("send"/"enviar"/"submit")
  // 2) button[type="submit"]
  // 3) heurística posicional (mais à direita, ícone pequeno), EXCLUINDO
  //    qualquer botão cujo aria-label/title indique mic/anexo/voz/upload.
  const _SEND_HINT    = /send|enviar|submit/i;
  // stop/cancel entraram aqui em 2026-09-09: enquanto o agente roda, o Lovable
  // troca o botão de enviar por um de PARAR, no mesmo lugar. Sem excluí-lo, o
  // fallback "botão pequeno mais à direita" elegia o stop, e o overlay
  // transparente (z-index 2147483646) cobria ele — o clique morria no overlay e
  // era impossível interromper o envio.
  const _STOP_HINT    = /stop|parar|interromper|cancel|cancelar|abort/i;
  const _EXCLUDE_HINT = /mic|voice|attach|upload|anexo|gravar|record|áudio|audio|stop|parar|interromper|cancel|cancelar|abort/i;
  function findSendButton(form) {
    if (!form) return null;
    const btns = Array.from(form.querySelectorAll('button'));

    for (const b of btns) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
      if (_STOP_HINT.test(label)) continue;      // nunca confundir stop com enviar
      if (_SEND_HINT.test(label)) return b;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) return submitBtn;

    let best = null, bestScore = -Infinity;
    for (const b of btns) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
      if (_EXCLUDE_HINT.test(label)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 16 || r.height < 16 || r.width > 60 || r.height > 60) continue;
      const score = r.right * 2 + r.bottom; // prioriza "mais à direita"
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  // ── Improve Prompt ──────────────────────────────────────────────────────────
  const _MIC_HINT    = /mic|voice|gravar|record|áudio|audio|speak/i;
  const _ATTACH_HINT = /attach|upload|anexo|arquivo|file|clip/i;

  function findMicButton(form) {
    if (!form) return null;
    for (const b of form.querySelectorAll('button')) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
      if (_MIC_HINT.test(label)) return b;
    }
    return null;
  }

  function findAttachButton(form) {
    if (!form) return null;
    for (const b of form.querySelectorAll('button')) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
      if (_ATTACH_HINT.test(label)) return b;
    }
    return null;
  }

  // Atualiza textarea OU contenteditable (Lovable usa div[contenteditable] no chat nativo).
  // Para textarea: bypassa o override do React via native setter.
  // Para contenteditable: execCommand('insertText') dispara os eventos nativos que o React escuta.
  function _setTextareaReact(ta, value) {
    try {
      if (ta.tagName === 'TEXTAREA') {
        const ns = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (ns && ns.set) ns.set.call(ta, value); else ta.value = value;
        ta.dispatchEvent(new Event('input',  { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // div[contenteditable] — seleciona tudo e substitui pelo texto melhorado
        ta.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(ta);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        // insertText dispara o evento 'beforeinput'+'input' que o React usa no contenteditable
        const ok = document.execCommand('insertText', false, value);
        if (!ok || (ta.textContent || '').trim() !== value.trim()) {
          // fallback: set direto + dispara input manualmente
          ta.textContent = value;
          // Move cursor para o fim
          const sel2 = window.getSelection();
          if (sel2 && ta.lastChild) {
            const r2 = document.createRange();
            r2.setStartAfter(ta.lastChild); r2.collapse(true);
            sel2.removeAllRanges(); sel2.addRange(r2);
          }
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } catch(e) {
      try {
        ta.textContent = value;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } catch(_) {}
    }
  }

  // ── Melhorador de Prompt ─────────────────────────────────────────────────
  // Regra principal: NUNCA adicionar funcionalidades, requisitos ou itens não pedidos.
  // Apenas reescrever o prompt para ser mais claro, específico e fácil de executar.
  // Para pedidos de MELHORIA: gera "Analise X existente..." preservando escopo.
  // Para pedidos de CRIAÇÃO: clarifica sem expandir o escopo.
  function _qlImproveOffline(raw) {
    const text = raw.trim();
    if (!text || text.length < 3) return text;
    const low = text.toLowerCase();
    const has = (...w) => w.some(x => low.includes(x));
    const wordCount = text.split(/\s+/).length;

    // Detecta se é pedido de MELHORIA (de algo que já existe)
    const isMelhorar = has(
      'melhore','melhora','melhorar','otimize','otimizar',
      'corrija','corrigir','revise','revisar','refatore','refatorar',
      'ajuste','ajustar','conserte','consertar','atualize','atualizar',
      'organize','organizar','simplifique','simplificar','limpe','limpar',
      'melhoria','revisão','revisao','ajuste','otimização','otimizacao'
    );

    if (isMelhorar) {
      // Coleta TODOS os tópicos presentes — não para no primeiro match
      const topicos = [];

      if (has('banco de dado','banco dados','database','schema','migration','sql','postgres','mysql','sqlite','prisma','tabela','relacionamento'))
        topicos.push('Banco de dados: Analise toda a estrutura atual do banco de dados mantendo sua arquitetura existente. Identifique inconsistências, redundâncias, problemas de relacionamento, nomenclatura inadequada e questões de organização. Não adicione novas tabelas, campos ou tecnologias que não façam parte do projeto.');

      if (has('design','designer','ui','ux','interface','layout','visual','estilo','aparência','aparencia','componente','component','tela'))
        topicos.push('Design / Interface: Analise a interface existente no projeto e identifique melhorias nos elementos já implementados. Melhore a organização visual, consistência e clareza dos componentes existentes. Não adicione novos elementos, animações, seções ou funcionalidades não solicitadas.');

      if (has('landing','página de vendas','sales page','landing page','página de captura'))
        topicos.push('Página de vendas: Analise a página existente e otimize sua estrutura atual. Melhore a clareza dos textos já presentes e a hierarquia das informações. Não crie novas seções, botões ou funcionalidades que não tenham sido explicitamente solicitadas.');

      if (has('código','code','função','function','arquivo','file','classe','class','lógica','logica','algoritmo'))
        topicos.push('Código: Analise o código existente e identifique melhorias de qualidade dentro do escopo atual. Foque em clareza, organização e eliminação de duplicações. Preserve totalmente a lógica de negócio e o comportamento atual.');

      if (has('performance','performan','lento','veloc','cache','carregamento'))
        topicos.push('Performance: Analise e identifique os principais gargalos nos pontos já implementados. Proponha otimizações dentro do escopo atual sem adicionar novas bibliotecas ou serviços externos.');

      if (has('api','endpoint','rota','route','backend','servidor'))
        topicos.push('API / Backend: Analise os endpoints e rotas existentes e identifique melhorias dentro da implementação atual. Não adicione novos endpoints ou parâmetros além dos já presentes.');

      if (has('autenticação','autenticacao','auth','login','senha','jwt','token','permissão'))
        topicos.push('Autenticação: Analise o sistema de autenticação existente e identifique pontos de melhoria. Não adicione novos métodos de autenticação ou provedores. Preserve o fluxo já implementado.');

      if (has('formulário','form','input','campo','validação','validacao'))
        topicos.push('Formulário: Analise o formulário existente e identifique melhorias dentro dos campos e validações já implementados. Não adicione novos campos ou funcionalidades não solicitadas.');

      if (has('seo','meta tag','open graph','sitemap','indexação','indexacao'))
        topicos.push('SEO: Analise as configurações de SEO existentes e identifique melhorias dentro do que já está implementado. Não adicione novas páginas ou estruturas de conteúdo.');

      // Tópico genérico: só entra se nenhum específico foi detectado
      if (topicos.length === 0) {
        const alvo = text
          .replace(/^(melhore?a?|otimize?|refatore?|corrija?|revise?|ajuste?|organize?|simplifique?|conserte?|atualize?|limpe?)\s+(o\s+|a\s+|os\s+|as\s+|meu\s+|minha\s+|nosso\s+|nossa\s+|todo\s+|toda\s+)?/i, '')
          .trim() || 'o elemento solicitado';
        return `Analise ${alvo} no projeto e identifique melhorias dentro do escopo existente. Não adicione novas funcionalidades, tecnologias ou recursos que não façam parte do projeto. Preserve tudo que já está funcionando.`;
      }

      // Único tópico: retorna diretamente o texto do tópico (sem prefixo de lista)
      if (topicos.length === 1) return topicos[0].replace(/^[^:]+:\s*/, '');

      // Múltiplos tópicos: lista numerada com cabeçalho
      return 'Analise o projeto e realize as seguintes melhorias dentro do escopo existente, sem adicionar novas funcionalidades ou recursos não solicitados:\n\n' +
        topicos.map((t, i) => (i + 1) + '. ' + t).join('\n\n');
    }

    // ── Prompt de CRIAÇÃO ou INSTRUÇÃO GERAL ──────────────────────────────
    // Não é "melhore X" — pode ser "crie X", "adicione Y", conversa, pergunta, etc.

    // Prompts conversacionais/exploratórios: não fazem sentido com sufixo de implementação.
    // Ex: "me ajude a escolher", "o que você acha", "vamos conversar", "quais opções"
    const isConversa = has(
      'me ajude','me ajuda','ajude-me','ajuda-me',
      'o que você','o que voce','o que acha','o que podemos','o que devo',
      'quais são','quais sao','quais opç','quais opc','quais funcionalidades','quais recursos',
      'pode me','consegue me','me explique','me mostre','me liste','me dê',
      'me sugira','me recomend','me indica',
      'por onde começ','por onde comecar','como faço','como faz','como posso',
      'vamos conversar','vamos pensar','vamos discutir','vamos planejar',
      'me ajude a escolher','me ajude a decidir','me ajude a definir',
      'ajude a escolher','ajude a decidir','ajude a definir',
      'sugestão','sugestao','sugerir','recomendar','indicar'
    );

    // Também retorna sem alterar se o prompt termina em "?" (pergunta)
    if (isConversa || text.endsWith('?')) {
      return text;
    }

    // Prompt já detalhado (implementação clara): adicionar apenas cláusula de escopo
    if (wordCount > 30) {
      return text + '\n\nImportante: implemente exatamente o descrito acima, sem adicionar funcionalidades, bibliotecas ou modificações não solicitadas. Siga os padrões de código e a arquitetura já existente no projeto.';
    }

    // Prompt de criação curto/médio: fallback offline gera briefing básico
    const isCriar = has('crie','criar','adicione','adicionar','implemente','implementar',
      'construa','construir','faça','fazer','desenvolva','desenvolver','gere','gerar',
      'monte','montar','configure','configurar','coloque','colocar','vamos criar','vamos fazer',
      'vamos adicionar','vamos construir','vamos implementar','vamos desenvolver');

    if (isCriar && wordCount > 4) {
      const alvo = text
        .replace(/^(crie?|construa|faça|adicione?|implemente?|desenvolva|monte|configure?|gere?|vamos\s+\w+)\s+(uma?\s+|o\s+|a\s+|os\s+|as\s+|meu\s+|minha\s+|novo\s+|nova\s+)?/i, '')
        .trim() || text;
      return `Crie ${alvo} completo(a) e profissional.

Inclua todos os elementos necessários para que o resultado seja funcional e visualmente agradável. Organize o conteúdo de forma clara e hierárquica. Utilize boas práticas de UX/UI com layout responsivo para mobile e desktop. Adicione dados de exemplo realistas onde necessário para demonstrar o funcionamento.

Siga os padrões de código, tecnologias e arquitetura já presentes no projeto. Não adicione bibliotecas externas ou funcionalidades além do que foi descrito.`;
    }

    // Qualquer outro prompt curto/ambíguo: retorna sem alterar
    return text;


  }

  async function _qlImproveOnline(text) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(_QO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': _QO_KEY, 'Authorization': 'Bearer ' + _QO_KEY },
        body: JSON.stringify({ prompt: text }),
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (!res.ok) throw new Error('status ' + res.status);
      const data = await res.json();
      if (data && data.improved && typeof data.improved === 'string') return data.improved.trim() || text;
      return null;
    } catch(_) { return null; }
  }

  async function handleImprovePrompt(btn) {
    const ta = findTextarea(_form);
    if (!ta) { showToast('✗ Textarea não encontrado', false); return; }
    const text = (ta.tagName === 'TEXTAREA' ? ta.value : ta.textContent || '').trim();
    if (!text) { showToast('✏️ Digite um prompt primeiro...', false); return; }

    const origHTML = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.style.setProperty('opacity', '0.45', 'important'); btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:__ql_spin 0.8s linear infinite;pointer-events:none"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'; }

    try {
      const online = await _qlImproveOnline(text);
      const improved = (online !== null) ? online : _qlImproveOffline(text);
      _setTextareaReact(ta, improved);
      ta.focus();
      try { ta.setSelectionRange(improved.length, improved.length); } catch(_) {}
      showToast('✅ Prompt melhorado com sucesso!', true);
    } finally {
      if (btn) { btn.disabled = false; btn.style.setProperty('opacity', '1', 'important'); if (origHTML) btn.innerHTML = origHTML; }
    }
  }

  function injectImproveButton() {
    if (!_form || !_active) return;

    // Verifica se o botão já está injetado E ainda está dentro do form
    const existing = document.getElementById('__ql_improve_btn__');
    if (existing && _form.contains(existing)) return;
    if (existing) existing.remove();

    const micBtn  = findMicButton(_form);
    const sendBtn = findSendButton(_form);
    const anchor  = micBtn || sendBtn;
    if (!anchor || !anchor.parentElement) return;

    // Copia dimensões do botão âncora para ficar idêntico visualmente
    const anchorRect = anchor.getBoundingClientRect();
    const btnSize = Math.round(Math.min(Math.max(anchorRect.width || 32, 28), 40)) + 'px';

    const btn = document.createElement('button');
    btn.id   = '__ql_improve_btn__';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Melhorar Prompt com IA');
    btn.title = 'Melhorar Prompt com IA (Lovable ∞)';
    btn.style.cssText =
      'display:inline-flex!important;align-items:center!important;justify-content:center!important;' +
      'width:' + btnSize + '!important;height:' + btnSize + '!important;' +
      'min-width:28px!important;min-height:28px!important;' +
      'border:none!important;border-radius:8px!important;' +
      'background:linear-gradient(135deg,#7c3aed,#9f5ae5)!important;' +
      'color:#fff!important;cursor:pointer!important;font-size:15px!important;' +
      'padding:0!important;margin:0 2px!important;flex-shrink:0!important;' +
      'box-shadow:0 1px 6px rgba(124,58,237,0.45)!important;' +
      'opacity:1!important;transition:opacity 0.15s,transform 0.1s!important;' +
      'vertical-align:middle!important;line-height:1!important;';
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>';

    btn.addEventListener('mouseenter', () => { btn.style.setProperty('opacity', '0.85', 'important'); btn.style.setProperty('transform', 'scale(1.08)', 'important'); });
    btn.addEventListener('mouseleave', () => { btn.style.setProperty('opacity', '1',    'important'); btn.style.setProperty('transform', 'scale(1)',    'important'); });
    btn.addEventListener('touchstart', () => { btn.style.setProperty('opacity', '0.8',  'important'); }, { passive: true });
    btn.addEventListener('touchend',   () => { btn.style.setProperty('opacity', '1',    'important'); }, { passive: true });

    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      handleImprovePrompt(btn);
    });
    btn.addEventListener('touchend', (e) => {
      e.preventDefault(); e.stopPropagation();
      handleImprovePrompt(btn);
    }, { passive: false });

    // Insere à esquerda do botão âncora (mic ou send)
    anchor.parentElement.insertBefore(btn, anchor);

    // Move o microfone para ao lado do botão de anexo (esquerda)
    if (micBtn) {
      const attachBtn = findAttachButton(_form);
      if (attachBtn && attachBtn.parentElement && attachBtn !== micBtn) {
        try { attachBtn.parentElement.insertBefore(micBtn, attachBtn.nextSibling); } catch(_) {}
      }
    }
  }

  // IMPORTANTE: sempre consulta o textarea EM TEMPO REAL (nunca usa uma referência
  // em cache) — o React troca o elemento interno do form sem trocar o form em si,
  // então uma referência salva fica obsoleta e passa a ler sempre vazio.
  function getMessageText() {
    const ta = findTextarea(_form);
    if (!ta) return '';
    return ta.tagName === 'TEXTAREA' ? (ta.value || '') : (ta.textContent || '');
  }

  function setMessageText(v) {
    const ta = findTextarea(_form);
    if (!ta) return;
    if (ta.tagName === 'TEXTAREA') {
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ta.textContent = v;
    }
  }

  // Best-effort: captura anexos já visíveis no form (chips/preview do fluxo
  // "+" → Attach do Lovable nativo). Cobre dois padrões:
  //  1. Imagens — thumbnail <img> grande o bastante para não ser ícone.
  //  2. Arquivos não-imagem — chip com link <a href> para o arquivo (pdf/doc/etc).
  // Se o src/href for um blob: local, o backend não conseguirá buscá-lo —
  // funciona melhor para URLs já hospedadas (a maioria dos casos reais).
  function captureAttachments(form) {
    if (!form) return [];
    const atts = [];
    const seen = new Set();

    const imgs = form.querySelectorAll('img');
    for (const img of imgs) {
      try {
        const r = img.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        const src = img.currentSrc || img.src || '';
        if (!src || seen.has(src)) continue;
        seen.add(src);
        // mime_type (não "type") — é o campo que o edge function lê para
        // decidir se isto é imagem (f.mime_type || f.file_type)
        atts.push({ file_name: img.alt || 'imagem', download_url: src, mime_type: 'image/png' });
      } catch (_) {}
    }

    const links = form.querySelectorAll('a[href]');
    for (const a of links) {
      try {
        const href = a.href || '';
        if (!href || seen.has(href)) continue;
        if (!/\.(pdf|docx?|xlsx?|csv|zip|txt|pptx?)(\?|#|$)/i.test(href)) continue;
        seen.add(href);
        const name = (a.textContent || '').trim() || 'arquivo';
        atts.push({ file_name: name, download_url: href, mime_type: 'application/octet-stream' });
      } catch (_) {}
    }

    return atts;
  }

  // ── Intercepta o "Attach" nativo (menuitem do "+") ───────────────────────
  // O Attach nativo faz upload DIRETO pro Lovable — o arquivo nunca passa pelo
  // nosso proxy, então o backend não consegue buscá-lo (URL não é nossa/acessível).
  // Em vez de deixar o Lovable processar, abrimos nosso PRÓPRIO seletor de
  // arquivo e subimos pelo MESMO caminho que o sidepanel já usa (action:'upload'
  // no edge function — faz o PUT no GCS da Lovable server-side, sem CORS).
  function isAttachMenuItem(el) {
    if (!el) return false;
    // Desktop: dropdown do "+" com itens role="menuitem"
    const item = el.closest('[role="menuitem"]');
    if (item) {
      const txt = (item.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^attach$/i.test(txt)) return true;
    }
    // Mobile/responsivo: Lovable renderiza "Attach" como <label> com input[type=file]
    // direto na tela (sem dropdown/role=menuitem) — precisa de um match separado.
    const label = el.closest('label');
    if (label && label.querySelector('input[type="file"]')) {
      const txt = (label.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^attach$/i.test(txt)) return true;
    }
    // Mobile Kiwi: botão "+" (plus) do Lovable — identificado pelo SVG path específico
    // do ícone de plus que o Lovable usa. NÃO usa só span[data-button-content] porque
    // todos os botões do toolbar (mic, "...", Plan, send) têm o mesmo padrão — isso
    // causava que clicar em qualquer botão abria nosso picker de arquivo.
    if (_form) {
      const btnEl = el.closest('button');
      if (btnEl && _form.contains(btnEl)) {
        const path = btnEl.querySelector('svg path');
        const d = (path && path.getAttribute('d')) || '';
        // Path do ícone "+" do Lovable mobile (M11.25 18V12.75H6...)
        if (d.includes('V12.75H6') || d.includes('M11.25 18V12')) return true;
      }
    }
    return false;
  }

  // ── Utilitários de dispositivo ──────────────────────────────────────────────
  function _isMobile() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }

  // Regex do botão de aprovação do Lovable (Plan mode)
  const _APPROVE_HINT = /^(approve|aprovar|apply plan|aplicar plano|approve plan)$/i;

  function onDocClickCapture(e) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    if (!_active) return;
    if (_isRecordingActive()) return;

    if (_form) {
      const sendBtn = findSendButton(_form);
      if (sendBtn && (e.target === sendBtn || sendBtn.contains(e.target))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (hasUploadingAttachments()) { showToast('⏳ Aguarde o upload terminar...', false); return; }
        doSend();
        return;
      }
    }

    // ── Intercepta Attach nativo ─────────────────────────────────────────────
    if (!isAttachMenuItem(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Pede para o próprio menu nativo se fechar (Escape é o padrão Base UI/Radix)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    openOurFilePicker();
  }

  // Força releitura do token AGORA, direto do localStorage da própria página
  // (mesmas funções que o resto do content.js já usa para o polling passivo).
  // Sem isso, o widget só confiava no valor em cache (atualizado a cada ~2s) —
  // se o token expirar e a Lovable renovar bem nesse intervalo, o envio pode
  // sair com o token velho. O sidepanel já faz esse refresh ativo antes de
  // enviar (requestFreshTokenFromActiveTab); o widget nunca fazia.
  function refreshTokenFromPage() {
    try {
      const freshToken = readTokenFromLocalStorage();
      const pid = getProjectFromUrl();
      if (freshToken || pid) return saveToStorage(freshToken, pid);
    } catch (_) {}
    return Promise.resolve();
  }

  // Upload via background.js (não fetch direto do content script — evita
  // qualquer restrição de CSP da própria página do Lovable). O background
  // resolve token/projectId e chama o mesmo action:'upload' do edge function
  // que o sidepanel já usa (handleUpload — PUT no GCS da Lovable server-side).
  async function uploadFileViaProxy(file) {
    if (!isExtensionAlive()) throw new Error('Extensão recarregada — atualize a página (F5).');
    await refreshTokenFromPage();

    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const idx = String(result).indexOf(',');
        resolve(idx >= 0 ? String(result).slice(idx + 1) : result);
      };
      reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
      reader.readAsDataURL(file);
    });

    // Mesmo padrão de retry do doSend() — token pode estar stale na 1ª
    // tentativa (aba ficou um tempo em background, sessão rotacionou no
    // localStorage e não tínhamos recapturado ainda). Sem isso o upload
    // falhava direto e não tinha segunda chance, diferente do envio de texto.
    // Não recuperável: license_invalid/captcha_required/payment_required —
    // não tem nada a ver com token, retry não resolve.
    const RETRY_DEADLINE = Date.now() + 20000;
    let attempt = 0;
    let lastErr = null;

    while (true) {
      attempt++;
      if (attempt > 1) await refreshTokenFromPage();

      const resp = await new Promise((resolve) => {
        safeSendMessage({
          action:      'uploadAttachment',
          fileName:    file.name,
          contentType: file.type || 'application/octet-stream',
          fileData:    base64,
        }, resolve);
      });

      if (resp && resp.ok) return resp.result;

      lastErr = new Error((resp && resp.error) || 'Upload falhou.');
      if (/license_invalid:|captcha_required|payment_required/i.test(lastErr.message)) throw lastErr;

      const remaining  = RETRY_DEADLINE - Date.now();
      const retryDelay = /429|http_429/i.test(lastErr.message) ? 3000 : 1500;
      if (remaining <= retryDelay || attempt >= 3) throw lastErr;
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  const MAX_ATTACHMENTS = 10;

  // Processa N arquivos de uma vez (seletor, colar ou arrastar).
  //
  // IMPORTANTE: criar TODAS as entradas/chips primeiro (síncrono, num só loop),
  // e SÓ DEPOIS disparar os uploads. Antes, criação e upload aconteciam no
  // mesmo loop com await — isso fazia o 2º arquivo nem aparecer como chip até
  // o 1º terminar de subir (parecia "um por vez" em vez de listar tudo já).
  // Os uploads disparam em paralelo (Promise.all) — cada chip atualiza sozinho
  // quando o SEU upload terminar, independente do formato ou dos outros.
  async function processFiles(fileList) {
    const files = Array.from(fileList || []).slice(0, Math.max(0, MAX_ATTACHMENTS - _pendingAttachments.length));
    if (!files.length) return;

    const jobs = files.map((file) => {
      const isImg = (file.type || '').startsWith('image/');
      const localPreview = isImg ? URL.createObjectURL(file) : null;
      const entry = {
        file_id:       undefined,
        file_name:     file.name,
        file_size:     formatFileSize(file.size),
        local_preview: localPreview,
        download_url:  '',
        mime_type:     file.type || 'application/octet-stream',
        uploading:     true,
        failed:        false,
      };
      _pendingAttachments.push(entry);
      return { file, entry };
    });

    renderAttachmentChips();
    positionAttachmentChips();
    positionBanner();

    await Promise.all(jobs.map(async ({ file, entry }) => {
      try {
        const result = await uploadFileViaProxy(file);
        entry.file_id      = result.file_id || undefined;
        entry.download_url = result.download_url || result.public_url || entry.local_preview || '';
        entry.uploading     = false;
      } catch (err) {
        entry.uploading = false;
        entry.failed    = true;
        showToast('⚠ Falha no upload de ' + file.name + ': ' + (err && err.message || err), false);
      }
      renderAttachmentChips();
      positionAttachmentChips();
      positionBanner();
    }));
  }

  function openOurFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    input.accept = 'image/*,.pdf,.doc,.docx,.xlsx,.xls,.csv,.zip,.txt,.pptx';
    // Marca nosso picker para o interceptor _onNativeFileChange não o capturar
    input.setAttribute('data-ql-picker', '1');
    document.documentElement.appendChild(input);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.remove();
      await processFiles(files);
    });
    input.click();
  }

  // Intercepta mudanças em qualquer input[type=file] do Lovable (fase capture,
  // antes dos handlers React). Quando o usuário escolhe arquivo pelo picker
  // nativo (ex: label que isAttachMenuItem não detectou no mobile), pegamos os
  // arquivos, zeramos o input nativo e processamos pelo nosso proxy — evita que
  // Lovable processe o mesmo arquivo nativamente e cause double-send/attach.
  function _onNativeFileChange(e) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    if (!_active || !_form) return;
    const input = e.target;
    if (!input || input.type !== 'file') return;
    if (input.getAttribute('data-ql-picker') === '1') return; // nosso picker, ignora
    const files = Array.from(input.files || []);
    if (!files.length) return;
    e.stopImmediatePropagation();
    try { input.value = ''; } catch (_) {}
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    processFiles(files);
  }

  // ── Colar (Ctrl+V) e arrastar-e-soltar — mesma cobertura que o sidepanel já
  // tem, agora também no chat nativo. Bloqueia o evento (preventDefault) para
  // não duplicar com qualquer tratamento nativo do próprio Lovable.
  function onDocPaste(e) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    if (!_active || !_form || !_form.contains(e.target)) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    processFiles(files);
  }

  // ── Indicativo visual "solte aqui" enquanto o usuário arrasta um arquivo ──
  // Some sem isso: ninguém sabia se soltar ali ia fazer algo. Cobre uma área
  // generosa acima/ao redor do form (chat + textarea), ancorada no _form.
  function createDropHint() {
    if (_dropHint) return;
    const el = document.createElement('div');
    el.id = '__ql_nb_drophint__';
    el.style.cssText =
      'position:fixed!important;display:none!important;z-index:2147483647!important;' +
      'background:rgba(139,92,246,.14)!important;border:2px dashed #8b5cf6!important;' +
      'border-radius:14px!important;flex-direction:column!important;' +
      'align-items:center!important;justify-content:center!important;gap:6px!important;' +
      'pointer-events:none!important;font-family:sans-serif!important;text-align:center!important;';

    const icon = document.createElement('div');
    icon.textContent = '📥';
    icon.style.cssText = 'font-size:28px!important;';

    const title = document.createElement('div');
    title.textContent = 'Solte aqui para enviar pelo Lovable ∞';
    title.style.cssText = 'color:#fff!important;font-size:13px!important;font-weight:700!important;text-shadow:0 1px 4px rgba(0,0,0,.7)!important;padding:0 16px!important;';

    const sub = document.createElement('div');
    sub.textContent = 'sem gastar créditos';
    sub.style.cssText = 'color:rgba(255,255,255,.75)!important;font-size:11px!important;text-shadow:0 1px 3px rgba(0,0,0,.7)!important;';

    el.appendChild(icon);
    el.appendChild(title);
    el.appendChild(sub);
    document.documentElement.appendChild(el);
    _dropHint = el;
  }

  function removeDropHint() {
    if (_dropHint) { _dropHint.remove(); _dropHint = null; }
    _dragCounter = 0;
  }

  function positionDropHint() {
    if (!_dropHint || !_form) return;
    try {
      const r = _form.getBoundingClientRect();
      const top = Math.max(8, r.top - 320);
      _dropHint.style.top    = top + 'px';
      _dropHint.style.left  = r.left + 'px';
      _dropHint.style.width  = r.width + 'px';
      _dropHint.style.height = (r.bottom - top) + 'px';
    } catch (_) {}
  }

  function showDropHint() {
    createDropHint();
    positionDropHint();
    if (_dropHint) _dropHint.style.setProperty('display', 'flex', 'important');
  }

  function hideDropHint() {
    if (_dropHint) _dropHint.style.setProperty('display', 'none', 'important');
  }

  // Sem escopo a _form: o Lovable mostra a própria zona "Add files" cobrindo
  // uma área MAIOR que o form (o painel de chat inteiro) — escopar ao form
  // deixava o drop cair fora da nossa interceptação na maior parte da área.
  // stopImmediatePropagation em capture-phase no document garante que o
  // listener nativo do Lovable (anexado a qualquer elemento descendente)
  // nunca chega a rodar, então a zona "Add files" nem aparece.
  // Contador de dragenter/dragleave (igual ao padrão do sidepanel) — evita
  // flicker, já que esses eventos disparam em toda transição entre elementos.
  function onDocDragEnter(e) {
    if (!_active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    _dragCounter++;
    if (_dragCounter === 1) showDropHint();
  }

  function onDocDragOver(e) {
    if (!_active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onDocDragLeave(e) {
    if (!_active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    _dragCounter = Math.max(0, _dragCounter - 1);
    if (_dragCounter === 0) hideDropHint();
  }

  function onDocDrop(e) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    if (!_active) return;
    _dragCounter = 0;
    hideDropHint();
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    if (!files.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    processFiles(Array.from(files));
  }

  function qlComputeHWID() {
    return new Promise((resolve) => {
      safeGet(['__lv_pid'], async (r) => {
        const pid = r && r.__lv_pid;
        if (!pid) return resolve(null);
        try {
          const ua   = navigator.userAgent || 'ua';
          const lang = navigator.language  || 'lang';
          const plat = navigator.platform  || 'plat';
          const hc   = navigator.hardwareConcurrency || 0;
          const data = ua + '|' + lang + '|' + plat + '|' + hc + '|' + pid;
          const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
          const hex  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
          // Diagnóstico: se um cliente reportar "licença já conectada em outro
          // PC" no ENVIO (não no login), comparar esse hwid (8 chars) com o que
          // aparece no log da edge function ajuda a achar divergência de HWID
          // entre o contexto do sidepanel (login) e do content script (envio).
          console.log('[Lovable∞] hwid (envio):', hex.slice(0, 8) + '... | pid:', String(pid).slice(0, 8) + '...');
          resolve(hex);
        } catch (_) { resolve(null); }
      });
      // Se safeGet detectar contexto inválido, ele não chama o callback —
      // garante que a Promise não fique pendurada para sempre.
      setTimeout(() => { if (!isExtensionAlive()) resolve(null); }, 50);
    });
  }

  async function doSend() {
    if (!isExtensionAlive()) { teardownWidget(); showToast('⚠ Extensão recarregada — atualize a página (F5).', false); return; }
    if (_sending) return;
    if (hasUploadingAttachments()) { showToast('⏳ Aguarde o upload terminar...', false); return; }
    // Seta o flag ANTES do primeiro await para evitar double-fire: no mobile o
    // touchend e o click sintético gerado pelo browser podem chegar ambos antes
    // do microtask do refreshTokenFromPage resolver — sem isso, ambos passavam
    // pelo check acima e disparavam doSend() duas vezes.
    _sending = true;
    await refreshTokenFromPage();
    const rawMsg = getMessageText().trim();
    // Anexos: usa só o que SUBIMOS pelo nosso proxy (URL garantida acessível
    // pelo backend). Só faz fallback para DOM-scraping se não há nada staged —
    // combinar os dois causava double-attach quando isAttachMenuItem perdia o
    // intercept no mobile e o Lovable nativo já tinha processado o arquivo.
    const stagedAttachments = _pendingAttachments;
    const attachments = stagedAttachments.length > 0
      ? [...stagedAttachments]
      : [...captureAttachments(_form)];
    if (!rawMsg && attachments.length === 0) { _sending = false; return; }
    // Modo Plan selecionado no seletor nativo → prefixa para o Lovable entrar
    // em modo "discutir antes de construir" em vez de aplicar direto.
    const isPlanMode = getNativeMode(_form) === 'plan';
    const msgText = isPlanMode ? `Enter modo Plan: "${rawMsg}"` : rawMsg;
    setMessageText('');
    _pendingAttachments = [];
    renderAttachmentChips();
    positionAttachmentChips();
    positionBanner();
    try {
      const hwid = await qlComputeHWID();

      // ── Retry automático: até 4 tentativas em até 25s — igual ao handleSend
      // do sidepanel. O token capturado na 1ª tentativa pode estar stale (ex:
      // Lovable ainda não tinha rotacionado a sessão no localStorage no
      // instante exato da captura) → a partir da 2ª tentativa, recaptura o
      // token da página antes de reenviar. license_invalid: é definitivo
      // (licença bloqueada/expirada — não adianta retry); os demais erros
      // (401 "token inválido", rede, 429, 500) tentam de novo com token fresco.
      const RETRY_DEADLINE = Date.now() + 25000;
      let attempt = 0;
      let lastErrMsg = null;
      let ok = false;

      while (true) {
        attempt++;
        if (attempt > 1) await refreshTokenFromPage();

        // Se o token JÁ está visivelmente expirado (campo exp do JWT no
        // passado), nem gasta um round-trip de rede — o servidor só ia
        // devolver o mesmo 401 "Token inválido ou expirado". Espera o tempo
        // do retry normal na esperança do Supabase renovar a sessão sozinho
        // (autoRefreshToken) no localStorage da página antes da tentativa
        // seguinte.
        if (isTokenExpired(readTokenFromLocalStorage())) {
          lastErrMsg = 'Sessão do Lovable expirada. Recarregue a aba do Lovable (F5) e tente novamente.';
        } else {
          const resp = await new Promise((resolve) => {
            safeSendMessage({
              action:            'sendMessage',
              message:           msgText,
              attachments:       attachments,
              deviceFingerprint: hwid || undefined,
            }, resolve);
          });

          if (resp && (resp.ok || resp.success)) { ok = true; break; }

          lastErrMsg = (resp && resp.error) || 'Falha ao enviar. Tente novamente.';
          // Não recuperáveis — retry não resolve nenhum desses, precisam de ação manual:
          // license_invalid (licença bloqueada/expirada), captcha_required (Lovable pediu
          // verificação de segurança), payment_required (workspace sem créditos) e
          // free_fix_exhausted (cota gratuita da conta na Lovable zerada — insistir só
          // gastaria crédito do cliente, que é justamente o que a trava evita).
          if (/license_invalid:|captcha_required|payment_required|free_fix_exhausted/i.test(lastErrMsg)) break;
        }

        const remaining   = RETRY_DEADLINE - Date.now();
        const retryDelay  = /429|http_429/i.test(lastErrMsg) ? 3000 : 1500;
        if (remaining <= retryDelay || attempt >= 4) break;
        await new Promise(r => setTimeout(r, retryDelay));
      }

      if (ok) {
        showToast('✓ Enviado sem gastar créditos', true);
        refreshChatAfterSend();
      } else {
        const isHwidConflict = /hwid_mismatch:/i.test(lastErrMsg || '');
        const isCaptcha      = /captcha_required/i.test(lastErrMsg || '');
        const isPayment      = /payment_required/i.test(lastErrMsg || '');
        const isCotaZerada   = /free_fix_exhausted/i.test(lastErrMsg || '');
        if (isCotaZerada) {
          // A mensagem vem inteira do servidor depois do prefixo — assim dá para
          // ajustar a redação sem republicar a extensão. Nada foi enviado à
          // Lovable neste caso, então nenhum crédito foi gasto. O texto e os
          // anexos voltam pro cliente no bloco comum logo abaixo.
          showToast('⏳ ' + String(lastErrMsg).replace(/^\s*free_fix_exhausted:\s*/i, ''),
            false, 30000);   // mensagem longa, com 3 alternativas — precisa de tempo de leitura
        } else if (isCaptcha) {
          showToast('🤖 A Lovable pediu verificação de segurança (captcha). Desative a extensão, mande uma mensagem simples (ex: um ponto ".") pelo chat nativo do Lovable pra resolver, depois reative e tente de novo.', false, 12000);
        } else if (isPayment) {
          showToast('💳 Workspace sem créditos. Você precisa de pelo menos 1 crédito (pode usar os 5 grátis diários da Lovable) pra extensão funcionar.', false, 9000);
        } else {
          showToast(isHwidConflict
            ? '⚠ Hardware ID não confere (pode ocorrer até no mesmo PC). Abra a extensão Lovable ∞ e resete na tela de login.'
            : '⚠ ' + lastErrMsg, false);
        }
        // Servidor confirmou licença inválida/bloqueada/expirada (não é falha
        // transitória do validador, essa vem como "service_unavailable:") →
        // desloga de fato, em vez de só mostrar erro e deixar tentar de novo.
        // hwid_mismatch NÃO desloga aqui: pode ser falso positivo (emulação de
        // viewport mobile muda navigator.userAgent/platform, alterando o HWID
        // calculado no content script vs o usado no login) — deslogar destruiria
        // a sessão por nada; melhor só avisar e deixar o cliente tentar de novo.
        // captcha_required/payment_required também NÃO desloga — não tem
        // nenhuma relação com a licença, é só verificação anti-bot ou créditos.
        if (/license_invalid:/i.test(lastErrMsg || '')) {
          forceLogoutFromWidget();
        } else {
          setMessageText(rawMsg); // devolve o texto ORIGINAL (sem o prefixo de modo Plan)
          _pendingAttachments = stagedAttachments; // restaura — não perde o upload já feito
          renderAttachmentChips();
          positionAttachmentChips();
          positionBanner();
        }
      }
    } catch (_) {
      showToast('⚠ Erro ao enviar', false);
      setMessageText(rawMsg);
      _pendingAttachments = stagedAttachments;
      renderAttachmentChips();
      positionAttachmentChips();
      positionBanner();
    } finally {
      _sending = false;
    }
  }

  function _isRecordingActive() {
    if (!_form) return false;
    try {
      var els = _form.querySelectorAll('canvas, audio[src], [class*="wave" i], [class*="recording" i], [class*="waveform" i], [data-recording], [data-state="recording"]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].tagName === 'AUDIO') return true;
        var r = els[i].getBoundingClientRect();
        if (r.width > 10 && r.height > 5) return true;
      }
    } catch (_) {}
    try {
      var svgs = _form.querySelectorAll('svg');
      for (var k = 0; k < svgs.length; k++) {
        if (svgs[k].querySelectorAll('rect, line').length >= 5) {
          var sr = svgs[k].getBoundingClientRect();
          if (sr.width > 40 && sr.height > 10) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function _formHasAttachments() {
    if (_pendingAttachments.length > 0) return true;
    if (!_form) return false;
    for (const img of _form.querySelectorAll('img')) {
      try { const r = img.getBoundingClientRect(); if (r.width >= 20 && r.height >= 20) return true; } catch(_){}
    }
    return false;
  }

  /** Há um botão de parar visível no formulário? Enquanto o agente trabalha, o
   *  Lovable troca o enviar pelo stop na MESMA posição — e o overlay, que é
   *  transparente e fica por cima, engolia o clique. */
  function _hasStopButton() {
    if (!_form) return false;
    try {
      for (const b of _form.querySelectorAll('button')) {
        const label = (b.getAttribute('aria-label') || '') + ' ' +
                      (b.title || '') + ' ' + (b.getAttribute('data-testid') || '');
        if (!_STOP_HINT.test(label)) continue;
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    } catch (_) {}
    return false;
  }

  function positionOverlay() {
    if (!_overlay || !_form) return;
    if (_isRecordingActive()) {
      _overlay.style.display = 'none';
      return;
    }
    if (!getMessageText().trim() && !_formHasAttachments()) {
      _overlay.style.display = 'none';
      return;
    }
    // Agente rodando → o botão daquele canto é o STOP. Some com o overlay para
    // o clique chegar nele; nada aqui deve competir com interromper um envio.
    if (_hasStopButton()) {
      _overlay.style.display = 'none';
      return;
    }
    const sendBtn = findSendButton(_form);
    if (!sendBtn) { _overlay.style.display = 'none'; return; }
    try {
      const r = sendBtn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) { _overlay.style.display = 'none'; return; }
      _overlay.style.display = 'block';
      _overlay.style.top    = r.top    + 'px';
      _overlay.style.left   = r.left   + 'px';
      _overlay.style.width  = r.width  + 'px';
      _overlay.style.height = r.height + 'px';
    } catch (_) {}
  }

  function createOverlay() {
    if (_overlay) return;
    const ov = document.createElement('div');
    ov.id = '__ql_nb_overlay__';
    ov.style.cssText =
      'position:fixed!important;display:none!important;background:transparent!important;' +
      'cursor:pointer!important;z-index:2147483646!important;';
    ov.title = 'Enviar sem gastar créditos (Lovable ∞)';

    // Mobile (Kiwi/touch): intercepta touchstart/touchend diretamente.
    // preventDefault() no touchstart suprime o click posterior (browser spec),
    // evitando disparo duplo e a race condition onde o rAF reposiciona o overlay
    // entre touchstart e click — o que fazia o click cair no botão nativo.
    let _ovTouchValid = false;
    ov.addEventListener('touchstart', (e) => {
      _ovTouchValid = true;
      e.preventDefault(); e.stopPropagation();
    }, { passive: false });
    ov.addEventListener('touchmove', () => { _ovTouchValid = false; }, { passive: true });
    ov.addEventListener('touchend', (e) => {
      if (!_ovTouchValid) return;
      _ovTouchValid = false;
      e.preventDefault(); e.stopPropagation();
      if (hasUploadingAttachments()) { showToast('⏳ Aguarde o upload terminar...', false); return; }
      doSend();
    }, { passive: false });

    // Desktop: mantém o handler de click para mouse.
    ov.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (hasUploadingAttachments()) { showToast('⏳ Aguarde o upload terminar...', false); return; }
      doSend();
    });
    document.documentElement.appendChild(ov);
    _overlay = ov;
  }

  function removeOverlay() {
    if (_overlayResizeObs) { _overlayResizeObs.disconnect(); _overlayResizeObs = null; }
    if (_overlay) { _overlay.style.display = 'none'; }
    stopOverlayLoop();
  }

  // Acompanha o botão de enviar a cada frame (~16ms) enquanto a extensão está
  // ativa — substitui depender só de resize/scroll/MutationObserver/interval,
  // que deixavam uma janela de atraso (overlay desalinhado até o próximo
  // gatilho, exigindo refresh pra "pegar" no mobile/responsivo).
  let _lastOverlayTick = 0;
  function _overlayLoop(ts) {
    if (!_active) { _overlayRAF = null; return; }
    // Throttle ~60ms (≈16fps): seguir o botão não precisa de 60fps, e rodar
    // 2 querySelectorAll por frame (getMessageText + findSendButton) a 60fps
    // era CPU à toa. 16fps segue o botão sem lag perceptível e alivia máquinas
    // fracas/mobile.
    if (!ts || ts - _lastOverlayTick >= 60) {
      _lastOverlayTick = ts || 0;
      positionOverlay();
    }
    _overlayRAF = requestAnimationFrame(_overlayLoop);
  }
  function startOverlayLoop() {
    if (_overlayRAF) return;
    _overlayRAF = requestAnimationFrame(_overlayLoop);
  }
  function stopOverlayLoop() {
    if (_overlayRAF) { cancelAnimationFrame(_overlayRAF); _overlayRAF = null; }
    _lastOverlayTick = 0;
  }

  function onDocKeydown(e) {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    if (!_active || !_form || !_form.contains(e.target)) return;
    if (_isRecordingActive()) return;
    const tag = e.target && e.target.tagName;
    const isEditable = tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    if (!isEditable) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (hasUploadingAttachments()) { showToast('⏳ Aguarde o upload terminar...', false); return; }
      doSend();
    }
  }

  function resolveForm() {
    if (!isExtensionAlive()) { teardownWidget(); return; }
    const form = _qlFindChatPanel();
    if (form === _form) {
      positionNearForm();
      if (_active) positionOverlay();
      // Re-injeta o botão se o React o removeu sem trocar o form
      if (_active) injectImproveButton();
      return;
    }
    if (_form) highlightForm(false);
    _form = form;
    if (_active) highlightForm(true);
    positionNearForm();
    if (_active) positionOverlay();
    if (_active) injectImproveButton();
    // Sempre reconecta o observer ao form ATUAL — antes só criava se !_formResizeObs,
    // então quando o React remontava o form (novo elemento, mesmo ID), o observer
    // continuava no elemento morto e nunca mais disparava (bug de reposicionamento mobile).
    if (_formResizeObs) { _formResizeObs.disconnect(); _formResizeObs = null; }
    if (form) {
      _formResizeObs = new ResizeObserver(() => { positionNearForm(); if (_active) positionOverlay(); });
      _formResizeObs.observe(form);
    }
  }

  // Aplica a cor de status diretamente via JS (setProperty com 'important' SOBRESCREVE
  // o inline style anterior — diferente de uma regra de classe em <style>, que nunca
  // vence um inline style com !important, mesmo que a regra também use !important).
  function applyStatusColor(v) {
    const color = v ? '#22c55e' : '#ef4444';
    const glow  = v ? 'rgba(34,197,94,.35)'  : 'rgba(239,68,68,.35)';
    if (_btn) {
      _btn.style.setProperty('border-color', color, 'important');
      if (v) {
        _btn.style.setProperty('animation', '__ql_pulse 2s ease-in-out infinite', 'important');
      } else {
        _btn.style.setProperty('animation', 'none', 'important');
        _btn.style.setProperty('box-shadow', '0 0 0 3px ' + glow + ',0 4px 16px rgba(0,0,0,.5)', 'important');
      }
    }
    if (_dot) _dot.style.setProperty('background', color, 'important');
  }

  function setActive(v) {
    _active = v;
    safeSet({ [STORAGE_KEY]: v });
    applyStatusColor(v);
    updateBannerText(v);
    resolveForm();
    highlightForm(v);
    // Avisa pageHook.js para bloquear/liberar envios diretos à API da Lovable
    try { window.postMessage({ type: '__QL_SET_GUARD__', block: !v }, '*'); } catch(_) {}
    if (v) {
      createOverlay();
      positionOverlay();
      startOverlayLoop();
      injectImproveButton();
      document.addEventListener('keydown', onDocKeydown, true);
      document.addEventListener('click', onDocClickCapture, true);
      document.addEventListener('change', _onNativeFileChange, true);
      document.addEventListener('paste', onDocPaste, true);
      document.addEventListener('dragenter', onDocDragEnter, true);
      document.addEventListener('dragover', onDocDragOver, true);
      document.addEventListener('dragleave', onDocDragLeave, true);
      document.addEventListener('drop', onDocDrop, true);
    } else {
      removeOverlay();
      // Remove botão de melhorar prompt ao desativar
      const impBtn = document.getElementById('__ql_improve_btn__');
      if (impBtn) impBtn.remove();
      document.removeEventListener('keydown', onDocKeydown, true);
      document.removeEventListener('click', onDocClickCapture, true);
      document.removeEventListener('change', _onNativeFileChange, true);
      document.removeEventListener('paste', onDocPaste, true);
      document.removeEventListener('dragenter', onDocDragEnter, true);
      document.removeEventListener('dragover', onDocDragOver, true);
      document.removeEventListener('dragleave', onDocDragLeave, true);
      document.removeEventListener('drop', onDocDrop, true);
      removeDropHint();
    }
  }

  // ── Popup de confirmação ao DESATIVAR ────────────────────────────────────
  function showConfirmDeactivate(onConfirm) {
    if (document.getElementById('__ql_nb_confirm__')) return;
    const overlay = document.createElement('div');
    overlay.id = '__ql_nb_confirm__';
    overlay.style.cssText =
      'position:fixed!important;inset:0!important;background:rgba(0,0,0,.6)!important;' +
      'z-index:2147483647!important;display:flex!important;align-items:center!important;' +
      'justify-content:center!important;font-family:sans-serif!important;';

    const box = document.createElement('div');
    box.style.cssText =
      'background:#18181b!important;border:1px solid rgba(255,255,255,.12)!important;' +
      'border-radius:14px!important;padding:20px!important;max-width:320px!important;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.5)!important;';

    const title = document.createElement('div');
    title.textContent = '⚠ Desativar o bypass?';
    title.style.cssText = 'color:#fff!important;font-size:15px!important;font-weight:700!important;margin-bottom:8px!important;';

    const desc = document.createElement('div');
    desc.textContent = 'Se desativar e enviar pelo chat nativo do Lovable, as mensagens vão gastar créditos normalmente.';
    desc.style.cssText = 'color:rgba(255,255,255,.7)!important;font-size:13px!important;line-height:1.5!important;margin-bottom:18px!important;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex!important;gap:8px!important;justify-content:flex-end!important;';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.style.cssText =
      'background:transparent!important;border:1px solid rgba(255,255,255,.25)!important;' +
      'color:#fff!important;padding:8px 14px!important;border-radius:8px!important;' +
      'cursor:pointer!important;font-size:13px!important;font-weight:600!important;';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Desativar mesmo assim';
    confirmBtn.style.cssText =
      'background:#dc2626!important;border:none!important;color:#fff!important;' +
      'padding:8px 14px!important;border-radius:8px!important;cursor:pointer!important;' +
      'font-size:13px!important;font-weight:700!important;';

    cancelBtn.addEventListener('click', () => overlay.remove());
    confirmBtn.addEventListener('click', () => { overlay.remove(); onConfirm(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    row.appendChild(cancelBtn);
    row.appendChild(confirmBtn);
    box.appendChild(title);
    box.appendChild(desc);
    box.appendChild(row);
    overlay.appendChild(box);
    document.documentElement.appendChild(overlay);
  }

  function createToggleButton() {
    if (document.getElementById('__ql_nb_btn__')) return;
    const btn = document.createElement('button');
    btn.id = '__ql_nb_btn__';
    btn.type = 'button';
    btn.title = 'Lovable ∞ — Enviar sem gastar créditos';
    btn.style.cssText =
      'position:fixed!important;bottom:24px!important;right:24px!important;' +
      'width:44px!important;height:44px!important;border-radius:50%!important;' +
      'border:2px solid #ef4444!important;background:#18181b!important;' +
      'cursor:pointer!important;z-index:2147483647!important;padding:0!important;' +
      'display:flex!important;align-items:center!important;justify-content:center!important;' +
      'box-shadow:0 0 0 3px rgba(239,68,68,.35),0 4px 16px rgba(0,0,0,.5)!important;' +
      'transition:box-shadow .2s, border-color .2s!important;';

    const img = document.createElement('img');
    img.src = safeGetURL('icon.png');
    img.style.cssText = 'width:24px!important;height:24px!important;border-radius:50%!important;pointer-events:none!important;';
    btn.appendChild(img);

    const dot = document.createElement('span');
    dot.id = '__ql_nb_dot__';
    dot.style.cssText =
      'position:absolute!important;bottom:-2px!important;right:-2px!important;' +
      'width:14px!important;height:14px!important;border-radius:50%!important;' +
      'border:2px solid #18181b!important;background:#ef4444!important;transition:background .2s!important;';
    btn.appendChild(dot);
    _dot = dot;

    createStatusBanner();
    updateBannerText(false);
    createAttachmentChips();

    btn.addEventListener('click', () => {
      if (_dragMoved) return;
      if (_active) showConfirmDeactivate(() => setActive(false));
      else setActive(true);
    });

    let dragging = false, _dragMoved = false, startX = 0, startY = 0, baseTop = 0, baseLeft = 0;
    btn.addEventListener('pointerdown', (e) => {
      dragging = true; _dragMoved = false;
      startX = e.clientX; startY = e.clientY;
      const rect = btn.getBoundingClientRect();
      baseTop  = rect.top;
      baseLeft = rect.left;
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    });
    btn.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) _dragMoved = true;
      if (!_dragMoved) return;
      _dragged = true; // a partir daqui, para de auto-ancorar no form
      btn.style.top    = Math.max(8, baseTop  + dy) + 'px';
      btn.style.left   = Math.max(8, baseLeft + dx) + 'px';
      btn.style.right  = 'auto';
      btn.style.bottom = 'auto';
    });
    btn.addEventListener('pointerup', (e) => {
      dragging = false;
      if (_dragMoved) {
        safeSet({ [POS_KEY]: { top: btn.style.top, left: btn.style.left } });
      }
      try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    document.documentElement.appendChild(btn);
    _btn = btn;

    safeGet([POS_KEY], (r) => {
      if (r && r[POS_KEY] && r[POS_KEY].top && r[POS_KEY].left) {
        const savedTop  = parseFloat(r[POS_KEY].top)  || 0;
        const savedLeft = parseFloat(r[POS_KEY].left) || 0;
        // Valida a posição salva contra o viewport atual — ela pode ser de uma
        // sessão desktop com viewport muito maior (ex: left:1200px em mobile de 360px).
        // Se estiver fora da tela, descarta e ancora no form como se fosse a 1ª vez.
        if (savedTop >= 8 && savedLeft >= 8 &&
            savedTop  < window.innerHeight - 36 &&
            savedLeft < window.innerWidth  - 36) {
          _dragged = true;
          btn.style.top    = r[POS_KEY].top;
          btn.style.left   = r[POS_KEY].left;
          btn.style.right  = 'auto';
          btn.style.bottom = 'auto';
        } else {
          try { chrome.storage.local.remove(POS_KEY); } catch (_) {}
          positionNearForm();
        }
      } else {
        positionNearForm(); // sem posição salva — ancora perto do chat
      }
    });
  }

  // Remove o botão e desativa o bypass (sem popup — é uma desativação forçada
  // por perda de licença, não uma escolha do usuário).
  function destroyToggleButton() {
    if (_active) {
      _active = false;
      removeOverlay();
      document.removeEventListener('keydown', onDocKeydown, true);
      document.removeEventListener('click', onDocClickCapture, true);
      document.removeEventListener('paste', onDocPaste, true);
      document.removeEventListener('dragenter', onDocDragEnter, true);
      document.removeEventListener('dragover', onDocDragOver, true);
      document.removeEventListener('dragleave', onDocDragLeave, true);
      document.removeEventListener('drop', onDocDrop, true);
      removeDropHint();
      safeSet({ [STORAGE_KEY]: false });
    }
    if (_form) { highlightForm(false); }
    if (_btn) { _btn.remove(); _btn = null; }
    _dot = null;
    removeStatusBanner();
    removeAttachmentChips();
    _pendingAttachments = [];
  }

  // Protege contra leituras vazias do chrome.storage (pressão de memória no Kiwi/Android).
  // PROBLEMA com timer: quando o celular fica em background por >90s, o setInterval é pausado.
  // Ao retornar, a leitura vazia + timer expirado destruía o widget imediatamente.
  // SOLUÇÃO: contar falhas CONSECUTIVAS — o background não incrementa o contador.
  // Só destrói depois de N leituras ruins seguidas (sem nenhuma boa no meio).
  // Intercepta clique no botão Send nativo quando extensão inativa
  function _onNativeSendCapture(e) {
    if (_active) return;
    if (_creditWarningAllowed) return;
    if (!_form) return;
    const btn = e.target ? e.target.closest('button') : null;
    if (!btn) return;
    const sendBtn = findSendButton(_form);
    if (!sendBtn || btn !== sendBtn) return;
    const ta = findTextarea(_form);
    if (!ta) return;
    const txt = (ta.tagName === 'TEXTAREA' ? ta.value : ta.textContent || '').trim();
    if (!txt) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    _showCreditWarningModal(() => {
      _creditWarningAllowed = true;
      try { btn.click(); } catch(_) {}
      setTimeout(() => { _creditWarningAllowed = false; }, 600);
    });
  }

  // Intercepta Enter no textarea quando extensão inativa
  function _onNativeEnterCapture(e) {
    if (_active) return;
    if (_creditWarningAllowed) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (!_form) return;
    const ta = findTextarea(_form);
    if (!ta) return;
    const inside = ta === e.target || ta.contains(e.target);
    if (!inside) return;
    const txt = (ta.tagName === 'TEXTAREA' ? ta.value : ta.textContent || '').trim();
    if (!txt) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    _showCreditWarningModal(() => {
      _creditWarningAllowed = true;
      try {
        const sendBtn = findSendButton(_form);
        if (sendBtn) sendBtn.click();
      } catch(_) {}
      setTimeout(() => { _creditWarningAllowed = false; }, 600);
    });
  }

  let _licenseGateMisses = 0;
  const _LICENSE_MAX_MISSES = 4; // 4 × 20s = 80s de leituras ruins seguidas para destruir

  function syncLicenseGate() {
    safeGet(LICENSE_KEYS, (s) => {
      const ok = hasValidLicense(s);
      if (ok) {
        _licenseGateMisses = 0; // reseta ao confirmar licença
        if (!_btn) {
          createToggleButton();
          resolveForm();
          setActive(true);
        }
      } else if (_btn) {
        _licenseGateMisses++;
        if (_licenseGateMisses >= _LICENSE_MAX_MISSES) {
          destroyToggleButton();
        }
      }
    });
  }

  function initNativeBypassWidget() {
    syncLicenseGate();
    resolveForm();

    // Coalesce mutações: numa SPA React o body muda centenas de vezes por
    // segundo. Chamar resolveForm a cada mutação era desperdício de CPU (e
    // podia sobrecarregar o content script). rAF agrupa tudo num único
    // resolveForm por frame.
    let _resolvePending = false;
    const obs = new MutationObserver(() => {
      if (_resolvePending) return;
      _resolvePending = true;
      requestAnimationFrame(() => { _resolvePending = false; resolveForm(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });

    const reposition = () => { positionNearForm(); if (_active) positionOverlay(); };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    // Mobile (Kiwi/Android): visualViewport dispara ao abrir/fechar teclado virtual,
    // onde window.resize é inconsistente — garante reposicionamento imediato do overlay.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', reposition);
      window.visualViewport.addEventListener('scroll', reposition);
    }
    // Tracking contínuo do botão (habilitado/desabilitado, mudanças de layout
    // mobile/responsivo) é feito pelo loop de rAF — ver startOverlayLoop().

    // Reage a mudanças de licença (login, logout, expiração marcada pelo heartbeat)
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (LICENSE_KEYS.some(k => k in changes)) syncLicenseGate();
      });
    } catch (_) { teardownWidget(); }

    // Quando a aba volta do background (tela do celular desbloqueou, app voltou ao foco):
    // reseta o contador de misses ANTES da próxima syncLicenseGate para não contar
    // o tempo em background como "falhas consecutivas" e destruir o widget indevidamente.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        _licenseGateMisses = 0;
        syncLicenseGate();
      }
    });

    // Cobre expiração por TEMPO (ql_expires_at no passado) sem precisar de um
    // evento de storage — o heartbeat do sidepanel pode não estar rodando.
    setInterval(syncLicenseGate, 20000);

    // ── Detector de gasto de crédito (sempre ativo, mesmo quando extensão inativa) ──
    // Intercepta qualquer tentativa de envio nativo quando _active === false,
    // mostrando aviso e opção de cancelar+reload antes de gastar créditos.
    document.addEventListener('click',   _onNativeSendCapture,  true);
    document.addEventListener('keydown', _onNativeEnterCapture, true);

    // Sincroniza estado inicial do guard com pageHook.js (pode já ter carregado)
    // Aguarda 500ms para dar tempo ao pageHook injetar e registrar o listener
    setTimeout(function() {
      try { window.postMessage({ type: '__QL_SET_GUARD__', block: !_active }, '*'); } catch(_) {}
    }, 500);
  }

  if (document.body) initNativeBypassWidget();
  else document.addEventListener('DOMContentLoaded', initNativeBypassWidget);

  // ── Oculta anexo instrucoes.md do DOM ────────────────────────────────────────
  // O servidor converte o prompt para .md e anexa ao payload. A Lovable exibe
  // esse anexo no chat, mas queremos escondê-lo para que não fique visível.
  // Outros tipos de anexos (imagens, PDFs, etc.) permanecem visíveis.
  function hideInstrucoesMd(root) {
    if (!root || !root.querySelectorAll) return;
    const candidates = root.querySelectorAll('a, span, div, p, button');
    for (const el of candidates) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt === 'instrucoes.md' || txt === 'instrucoes' || txt === 'instrucoes.md md' ||
          txt === 'agents.md' || txt === 'agents' || txt === 'agents.md md') {
        let container = el.closest('[class*="attachment"], [class*="file"], [class*="upload"], [data-testid*="file"], [data-testid*="attachment"]');
        if (!container) {
          let p = el.parentElement;
          for (let i = 0; i < 5 && p; i++) {
            const cls = (p.className || '').toLowerCase();
            // 'card' saiu da lista: bolha de mensagem do chat costuma ter
            // 'card' na classe, e subir até ela escondia a mensagem inteira.
            if (cls.includes('file') || cls.includes('attach') || cls.includes('upload') ||
                cls.includes('badge') || cls.includes('chip')) {
              container = p; break;
            }
            p = p.parentElement;
          }
        }
        // GUARDA (2026-09-09): a subida por className aceitava 'card', e bolha
        // de mensagem do chat costuma ter 'card' na classe — escondia a
        // mensagem inteira, às vezes o histórico junto. Agora que o servidor
        // realmente anexa instrucoes.md, isso passou a disparar em todo envio.
        // Um chip de anexo tem só o nome do arquivo: se o container carrega
        // texto demais, não é chip, é conteúdo de verdade — não esconder.
        const txtLen = (container && container.textContent || '').trim().length;
        if (container && container.style.display !== 'none' && txtLen <= 60) {
          container.style.display = 'none';
        }
      }
    }
  }

  function startHidingInstrucoes() {
    hideInstrucoesMd(document.body);
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) hideInstrucoesMd(node);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) startHidingInstrucoes();
  else document.addEventListener('DOMContentLoaded', startHidingInstrucoes);
})();
