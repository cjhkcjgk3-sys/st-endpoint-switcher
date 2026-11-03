const MODULE_ID = 'st-endpoint-switcher';
let instance = null;
let epoch = 0;

function context() { return globalThis.SillyTavern?.getContext?.(); }

function validateDraft(name, url) {
    name = name.trim();
    url = url.trim();
    if (!name) throw new Error('请填写接入点名称。');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('请填写完整网址，例如 https://example.com/v1。'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('网址必须以 http:// 或 https:// 开头。');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('接入点请填基础网址，API 密钥填在下面的密钥栏中。');
    if (/\/chat\/completions\/?$/.test(parsed.pathname)) throw new Error('请填写基础网址，去掉末尾的 /chat/completions。');
    return { name, url };
}

async function mount() {
    if (instance) return;
    const revision = epoch;
    const ctx = context();
    const container = document.getElementById('custom_form');
    if (!ctx || !container) return;
    const secrets = await import('/scripts/secrets.js');
    if (revision !== epoch || instance) return;
    if (typeof secrets.writeSecret !== 'function' || typeof secrets.rotateSecret !== 'function' || !secrets.SECRET_KEYS?.CUSTOM) {
        throw new Error('当前酒馆缺少多密钥管理接口，请使用 SillyTavern 1.18.0 或以上版本。');
    }
    const keyType = secrets.SECRET_KEYS.CUSTOM;
    const settings = ctx.extensionSettings[MODULE_ID] ??= { profiles: [] };
    if (!Array.isArray(settings.profiles)) settings.profiles = [];
    const root = document.createElement('section');
    root.id = 'ep-switcher';
    root.innerHTML = `
      <details open>
        <summary>接入点切换器</summary>
        <div class="ep-body">
          <div class="ep-select-row">
            <select id="ep-list" class="text_pole" aria-label="已保存的接入点"></select>
            <button type="button" id="ep-apply" class="menu_button">切换</button>
          </div>
          <div id="ep-current" class="ep-current"></div>
          <div class="ep-actions">
            <button type="button" id="ep-new" class="menu_button">新增</button>
            <button type="button" id="ep-capture" class="menu_button">保存当前</button>
            <button type="button" id="ep-edit" class="menu_button">编辑</button>
            <button type="button" id="ep-delete" class="menu_button">删除</button>
          </div>
          <div id="ep-editor" hidden>
            <label for="ep-name">名称</label>
            <input id="ep-name" class="text_pole" type="text" autocomplete="off" placeholder="例如：常用中转站">
            <label for="ep-url">接入点网址</label>
            <input id="ep-url" class="text_pole" type="url" inputmode="url" autocomplete="off" placeholder="https://example.com/v1">
            <label for="ep-key">API 密钥</label>
            <input id="ep-key" class="text_pole" type="password" autocomplete="new-password" spellcheck="false">
            <div class="ep-actions">
              <button type="button" id="ep-save" class="menu_button">保存并切换</button>
              <button type="button" id="ep-cancel" class="menu_button">取消</button>
            </div>
          </div>
          <div id="ep-status" role="status" aria-live="polite"></div>
        </div>
      </details>`;
    container.prepend(root);
    const ui = Object.fromEntries(['list','apply','current','new','capture','edit','delete','editor','name','url','key','save','cancel','status'].map(id => [id, root.querySelector(`#ep-${id}`)]));
    const abort = new AbortController();
    const listeners = [];
    let editingId = null;
    let retainedSecretId = '';
    let busy = false;

    function status(message, error = false) {
        ui.status.textContent = message;
        ui.status.classList.toggle('ep-error', error);
    }
    function activeSecret() { return secrets.secret_state[keyType]?.find(secret => secret.active)?.id || ''; }
    function hasSecret(id) { return !!id && !!secrets.secret_state[keyType]?.some(secret => secret.id === id); }
    function selected() { return settings.profiles.find(profile => profile.id === ui.list.value); }
    function ensureIdle() {
        if (document.body.dataset.generating === 'true') throw new Error('正在生成内容，请等生成结束后再切换。');
        if (document.getElementById('main_api')?.value !== 'openai' || ctx.chatCompletionSettings.chat_completion_source !== 'custom') throw new Error('请先在酒馆选择“聊天补全 → 自定义（OpenAI兼容）”。');
    }
    function updateCurrent() {
        const matches = item => item.url === ctx.chatCompletionSettings.custom_url && item.secretId === activeSecret();
        const profile = settings.profiles.find(item => item.id === ui.list.value && matches(item)) || settings.profiles.find(matches);
        ui.current.textContent = profile ? `当前：${profile.name}` : '当前连接尚未保存到此列表';
    }
    function updateButtons() {
        root.querySelectorAll('button,input,select').forEach(node => { node.disabled = busy; });
        for (const key of ['apply','edit','delete']) ui[key].disabled = busy || !selected();
    }
    function render(preferredId = ui.list.value) {
        ui.list.replaceChildren();
        if (!settings.profiles.length) ui.list.append(new Option('尚未保存接入点', ''));
        for (const profile of settings.profiles) ui.list.append(new Option(profile.name, profile.id));
        if (settings.profiles.some(item => item.id === preferredId)) ui.list.value = preferredId;
        updateCurrent();
        updateButtons();
    }
    function closeEditor() {
        ui.editor.hidden = true;
        ui.key.value = '';
        editingId = null;
        retainedSecretId = '';
    }
    function openEditor(profile = null, capture = false) {
        const pendingKey = capture ? document.getElementById('api_key_custom')?.value.trim() || '' : '';
        editingId = profile?.id || null;
        retainedSecretId = profile?.secretId || (capture && !pendingKey ? activeSecret() : '');
        ui.name.value = profile?.name || '';
        ui.url.value = profile?.url || (capture ? ctx.chatCompletionSettings.custom_url || '' : '');
        ui.key.value = pendingKey;
        ui.key.placeholder = retainedSecretId ? '已使用酒馆保存的密钥；留空保持，填写则替换' : '粘贴此接入点的 API 密钥';
        ui.editor.hidden = false;
        ui.name.focus();
        status('');
    }
    function setUrl(url) {
        const input = document.getElementById('custom_api_url_text');
        if (!input) throw new Error('未找到酒馆的自定义接入点网址设置。');
        ctx.chatCompletionSettings.custom_url = url;
        input.value = url;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    async function activate(profile, newKey = '') {
        ensureIdle();
        if (!newKey && !hasSecret(profile.secretId)) throw new Error('此接入点的密钥已不存在，请编辑并重新填写。');
        const previousUrl = ctx.chatCompletionSettings.custom_url;
        const previousSecret = activeSecret();
        const pendingKey = document.getElementById('api_key_custom');
        const previousPendingKey = pendingKey?.value || '';
        let createdSecret = '';
        try {
            // 密钥切换期间留空网址，避免临时出现“新网址＋旧密钥”的组合。
            setUrl('');
            if (pendingKey) { pendingKey.value = ''; pendingKey.dispatchEvent(new Event('input', { bubbles: true })); }
            if (newKey) {
                createdSecret = await secrets.writeSecret(keyType, newKey, `接入点 · ${profile.name}`);
                if (!createdSecret) throw new Error('密钥保存失败，请重试。');
                profile.secretId = createdSecret;
            } else if (activeSecret() !== profile.secretId) {
                await secrets.rotateSecret(keyType, profile.secretId);
            }
            if (revision !== epoch) throw new Error('插件已停用，本次切换已取消。');
            if (activeSecret() !== profile.secretId) throw new Error('密钥切换失败，请重试。');
            setUrl(profile.url);
            ctx.saveSettingsDebounced();
        } catch (error) {
            // 只撤销本次自己创建的密钥，不删除原有密钥。
            if (createdSecret) await secrets.deleteSecret(keyType, createdSecret);
            if (previousSecret && activeSecret() !== previousSecret) await secrets.rotateSecret(keyType, previousSecret);
            if (activeSecret() !== previousSecret) {
                setUrl('');
                throw new Error('切换失败，密钥未能恢复；请在酒馆密钥管理器检查后再连接。');
            }
            setUrl(previousUrl);
            if (pendingKey) pendingKey.value = previousPendingKey;
            throw error;
        }
    }
    async function action(callback) {
        if (busy) return;
        busy = true;
        updateButtons();
        try { await callback(); }
        catch (error) { status(error.message || '操作失败，请重试。', true); }
        finally { busy = false; updateCurrent(); updateButtons(); }
    }
    function connect() {
        // 全部切换完成后交回酒馆原生连接流程；插件从不读写模型或预设。
        document.getElementById('api_button_openai')?.click();
    }
    ui.apply.addEventListener('click', () => action(async () => {
        const profile = selected();
        if (!profile) return;
        validateDraft(profile.name, profile.url);
        await activate(profile);
        status(`已切换到 ${profile.name}，连接状态见酒馆。`);
        connect();
    }), { signal: abort.signal });
    ui.save.addEventListener('click', () => action(async () => {
        const draft = validateDraft(ui.name.value, ui.url.value);
        if (settings.profiles.some(item => item.id !== editingId && item.name === draft.name)) throw new Error('这个名称已经存在，请换一个名称。');
        const newKey = ui.key.value.trim();
        if (!newKey && !retainedSecretId) throw new Error('请填写 API 密钥，或用“保存当前”记录酒馆已配置的密钥。');
        const random = Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join('');
        const profile = { id: editingId || random, ...draft, secretId: retainedSecretId };
        await activate(profile, newKey);
        const index = settings.profiles.findIndex(item => item.id === profile.id);
        if (index < 0) settings.profiles.push(profile);
        else settings.profiles[index] = profile;
        ctx.saveSettingsDebounced();
        closeEditor();
        render(profile.id);
        status(`已保存并切换到 ${profile.name}，连接状态见酒馆。`);
        connect();
    }), { signal: abort.signal });
    ui.new.addEventListener('click', () => openEditor(), { signal: abort.signal });
    ui.capture.addEventListener('click', () => {
        try { ensureIdle(); openEditor(null, true); } catch (error) { status(error.message, true); }
    }, { signal: abort.signal });
    ui.edit.addEventListener('click', () => { if (selected()) openEditor(selected()); }, { signal: abort.signal });
    ui.cancel.addEventListener('click', closeEditor, { signal: abort.signal });
    ui.list.addEventListener('change', () => { closeEditor(); updateButtons(); }, { signal: abort.signal });
    ui.delete.addEventListener('click', () => action(async () => {
        const profile = selected();
        if (!profile) return;
        const confirmed = await ctx.Popup.show.confirm('删除接入点', '删除这条接入点记录？酒馆保存的密钥仍会保留。');
        if (!confirmed) return;
        settings.profiles = settings.profiles.filter(item => item.id !== profile.id);
        ctx.saveSettingsDebounced();
        closeEditor();
        render();
        status('已删除接入点记录。');
    }), { signal: abort.signal });
    // 内嵌于酒馆原生表单，避免回车误提交原生连接表单。
    root.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); if (!ui.editor.hidden && !busy) ui.save.click(); }
    }, { signal: abort.signal });
    document.getElementById('custom_api_url_text')?.addEventListener('input', updateCurrent, { signal: abort.signal });
    for (const event of [ctx.eventTypes.SECRET_WRITTEN, ctx.eventTypes.SECRET_ROTATED, ctx.eventTypes.SECRET_DELETED]) {
        if (!event) continue;
        const callback = () => updateCurrent();
        ctx.eventSource.on(event, callback);
        listeners.push([event, callback]);
    }
    render(settings.profiles.find(item => item.url === ctx.chatCompletionSettings.custom_url && item.secretId === activeSecret())?.id);
    instance = { destroy() { abort.abort(); listeners.forEach(([event, callback]) => ctx.eventSource.removeListener(event, callback)); root.remove(); } };
}

function start() {
    void mount().catch(() => globalThis.toastr?.error('接入点切换器初始化失败，请确认酒馆版本为 1.18.0 或以上。'));
}

export function onActivate() {
    if (document.getElementById('custom_form')) start();
    else { const ctx = context(); if (ctx) ctx.eventSource.once(ctx.eventTypes.APP_READY, start); }
}

export function onDisable() {
    epoch++;
    instance?.destroy();
    instance = null;
    const ctx = context();
    if (ctx) ctx.eventSource.removeListener(ctx.eventTypes.APP_READY, start);
}
