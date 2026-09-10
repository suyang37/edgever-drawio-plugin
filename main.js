// ============================================================
// EdgeEver Draw.io Plugin v1.0.0
// ============================================================
// Embeds draw.io diagram editor into EdgeEver notes.
// Uses draw.io embed protocol (postMessage + iframe) at
// https://embed.diagrams.net with JSON protocol.
// ============================================================
(function() {
  'use strict';

  // ============================================================
  // DrawioEditor class
  // ============================================================
  function DrawioEditor(config) {
    this.config = config || {};
    this.drawDomain = 'https://embed.diagrams.net/';
    this.ui = this.config.ui || 'min';
    this.frame = null;
    this.container = null;
    this.handlers = {};
    this.pendingCallbacks = {};
    this.msgId = 0;
    this._messageHandler = null;
  }

  DrawioEditor.prototype.on = function(event, callback) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(callback);
  };

  DrawioEditor.prototype.emit = function(event, data) {
    var handlers = this.handlers[event] || [];
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](data); } catch (e) { console.error(e); }
    }
  };

  DrawioEditor.prototype.createIframe = function(container) {
    var self = this;
    this.container = container;

    var iframe = document.createElement('iframe');
    var params = [];
    params.push('embed=1');
    params.push('proto=json');
    params.push('ui=' + this.ui);
    var url = this.drawDomain + '?' + params.join('&');
    iframe.src = url;
    iframe.style.cssText = 'position:absolute;border:0;width:100%;height:100%;background:transparent;';
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    this.frame = iframe;
    container.appendChild(iframe);

    // Message listener
    var messageHandler = function(evt) {
      if (evt.source !== iframe.contentWindow) return;
      if (!evt.data || typeof evt.data !== 'string') return;
      try {
        var msg = JSON.parse(evt.data);
        self.handleMessage(msg);
      } catch (e) {}
    };
    window.addEventListener('message', messageHandler);
    this._messageHandler = messageHandler;

    return iframe;
  };

  DrawioEditor.prototype.handleMessage = function(msg) {
    var self = this;
    var id = msg.id;

    if (msg.event === 'export' && id && this.pendingCallbacks[id]) {
      var cb = this.pendingCallbacks[id];
      delete this.pendingCallbacks[id];
      if (msg.error) {
        cb.reject(new Error(msg.error));
      } else {
        cb.resolve(msg.data || msg.xml || '');
      }
      return;
    }

    if (msg.event === 'configure') {
      this.frame.contentWindow.postMessage(JSON.stringify({
        event: 'configure',
        ui: this.ui,
        prefs: { 'embed': true, 'embed-save': true, 'embed-savecancel': false },
        style: 'default'
      }), this.drawDomain);
      return;
    }

    if (msg.event === 'ready') {
      this.emit('ready');
      return;
    }
    if (msg.event === 'save') {
      this.emit('save', msg.xml);
      return;
    }
    if (msg.event === 'exit') {
      this.emit('exit', { modified: msg.modified });
      return;
    }
    if (msg.event === 'autosave') {
      this.emit('autosave', msg.xml);
      return;
    }
  };

  DrawioEditor.prototype.load = function(xml) {
    var self = this;
    var id = ++this.msgId;
    return new Promise(function(resolve, reject) {
      self.pendingCallbacks[id] = { resolve: resolve, reject: reject };
      if (self.frame && self.frame.contentWindow) {
        self.frame.contentWindow.postMessage(JSON.stringify({
          event: 'load', id: id, xml: xml || '', autosave: 1, modified: 1
        }), self.drawDomain);
      }
    });
  };

  DrawioEditor.prototype.exportDiagram = function(format) {
    var self = this;
    var id = ++this.msgId;
    var fmt = format || 'xmlsvg';
    return new Promise(function(resolve, reject) {
      self.pendingCallbacks[id] = { resolve: resolve, reject: reject };
      if (self.frame && self.frame.contentWindow) {
        self.frame.contentWindow.postMessage(JSON.stringify({
          event: 'export', id: id, format: fmt, xml: ''
        }), self.drawDomain);
      }
    });
  };

  DrawioEditor.prototype.sendMessage = function(action, data) {
    if (this.frame && this.frame.contentWindow) {
      this.frame.contentWindow.postMessage(JSON.stringify(Object.assign({ event: action }, data)), '*');
    }
  };

  DrawioEditor.prototype.dispose = function() {
    if (this._messageHandler) {
      window.removeEventListener('message', this._messageHandler);
    }
    if (this.frame && this.frame.parentNode) {
      this.frame.parentNode.removeChild(this.frame);
    }
    this.frame = null;
    if (window._activeDrawioEditor === this) {
      window._activeDrawioEditor = null;
    }
  };

  // ============================================================
  // Plugin
  // ============================================================

  var DrawioPlugin = {
    _editor: null,
    _currentXml: '',

    activate: function(context) {
      var self = this;
      self.context = context;

      // Register command: open draw.io panel
      context.commands.register({
        id: 'drawio.open',
        title: 'Draw.io 图表编辑器',
        async run() { await self._openPanel(); }
      });

      // Register command: insert embed at cursor
      context.commands.register({
        id: 'drawio.insert',
        title: '插入 draw.io 图表到笔记',
        async run() { await self._openPanel(true); }
      });

      // Register embed renderer
      if (context.editor && context.editor.embeds) {
        context.editor.embeds.register({
          type: 'drawing',
          async mount(container, embed) {
            return self._renderEmbed(container, embed, context);
          }
        });
      }

      // Register panel
      context.ui.panels.register({
        id: 'drawio-editor',
        title: 'Draw.io 图表编辑器',
        purpose: 'workflow',
        presentation: 'fullscreen',
        mount: function(container, state, requestClose) {
          return self._mountPanel(container, state, requestClose, context);
        },
        beforeClose: function() { return true; }
      });

      // Save function
      context.commands.register({
        id: 'drawio.save',
        title: '保存图表',
        async run() {
          if (self._editor && self._editor._currentXml) {
            context.ui.showNotice('图表已保存');
          } else {
            context.ui.showNotice('没有打开的图表');
          }
        }
      });

      context.ui.showNotice('Draw.io 插件已加载 ✅');

      return function() {
        if (self._editor) {
          self._editor.dispose();
          self._editor = null;
        }
      };
    },

    // Open the draw.io editor panel
    _openPanel: async function(insertMode) {
      var self = this;
      try {
        await self.context.ui.panels.open('drawio-editor', {
          state: { insertMode: !!insertMode }
        });
      } catch (e) {
        self.context.ui.showNotice('❌ 打开面板失败: ' + e.message);
      }
    },

    // Mount panel content
    _mountPanel: async function(container, state, requestClose, context) {
      var self = this;
      var insertMode = state && state.insertMode;

      container.innerHTML = '';
      container.style.cssText = 'display:flex;flex-direction:column;height:100%;';

      // --- Toolbar ---
      var toolbar = document.createElement('div');
      toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--color-surface,#fff);border-bottom:1px solid var(--color-border,#e2e8f0);flex-shrink:0;';
      toolbar.innerHTML =
        '<button id="drawio-new" style="padding:6px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">新建</button>' +
        '<button id="drawio-open" style="padding:6px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">打开文件</button>' +
        '<span style="flex:1;"></span>' +
        '<span id="drawio-status" style="font-size:12px;color:#64748b;margin-right:8px;">就绪</span>' +
        '<button id="drawio-fit" style="padding:6px 12px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">适应</button>' +
        (insertMode
          ? '<button id="drawio-apply" style="padding:6px 16px;border:none;border-radius:6px;background:#16a06e;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">插入到笔记</button>'
          : '<button id="drawio-edit" style="padding:6px 16px;border:none;border-radius:6px;background:#16a06e;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">编辑笔记</button>'
        ) +
        '<button id="drawio-close" style="padding:6px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">关闭</button>';
      container.appendChild(toolbar);

      // --- Editor container ---
      var editorContainer = document.createElement('div');
      editorContainer.style.cssText = 'flex:1;position:relative;overflow:hidden;';
      container.appendChild(editorContainer);

      // --- Create editor ---
      var editor = new DrawioEditor({ ui: 'min' });
      self._editor = editor;
      window._activeDrawioEditor = editor;
      editor.createIframe(editorContainer);

      editor.on('ready', function() {
        var statusEl = document.getElementById('drawio-status');
        if (statusEl) statusEl.textContent = '就绪';
        if (self._currentXml) {
          editor.load(self._currentXml);
        }
      });

      editor.on('save', function(xml) {
        self._currentXml = xml;
        var statusEl = document.getElementById('drawio-status');
        if (statusEl) statusEl.textContent = '已保存';
      });

      // --- Toolbar actions ---
      document.getElementById('drawio-new').addEventListener('click', function() {
        self._currentXml = '';
        editor.load('');
        var statusEl = document.getElementById('drawio-status');
        if (statusEl) statusEl.textContent = '新建图表';
      });

      document.getElementById('drawio-open').addEventListener('click', function() {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.drawio,.xml,.svg';
        input.onchange = function(e) {
          var file = e.target.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function(ev) {
            self._currentXml = ev.target.result;
            editor.load(self._currentXml);
            var statusEl = document.getElementById('drawio-status');
            if (statusEl) statusEl.textContent = '加载: ' + file.name;
          };
          reader.readAsText(file);
        };
        input.click();
      });

      document.getElementById('drawio-fit').addEventListener('click', function() {
        editor.sendMessage('fit');
      });

      // Apply / Insert
      var applyBtn = document.getElementById(insertMode ? 'drawio-apply' : 'drawio-edit');
      applyBtn.addEventListener('click', async function() {
        try {
          var xml = self._currentXml;
          // Try to export from editor
          try {
            var result = await editor.exportDiagram('xmlsvg');
            if (result) xml = result;
          } catch (e) {}

          if (!xml) {
            context.ui.showNotice('⚠️ 没有图表内容');
            return;
          }

          await context.editor.insertEmbed({
            type: 'drawing',
            title: '流程图',
            data: { xml: xml }
          });
          context.ui.showNotice('✅ 图表已插入到笔记中');
          requestClose();
        } catch (e) {
          context.ui.showNotice('❌ 插入失败: ' + (e.message || '未知错误'));
        }
      });

      // Close
      document.getElementById('drawio-close').addEventListener('click', function() {
        requestClose();
      });

      return function() {
        if (editor) {
          editor.dispose();
          editor = null;
        }
      };
    },

    // Render embed preview in note editor
    _renderEmbed: async function(container, embed, context) {
      container.innerHTML = '';

      var data = embed.data || {};
      var xml = data.xml || '';

      try {
        if (xml) {
          var svgData = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
          var img = document.createElement('img');
          img.src = svgData;
          img.style.cssText = 'width:100%;max-width:100%;cursor:pointer;display:block;border-radius:6px;border:1px dashed var(--color-border,#e2e8f0);';
          img.title = '点击编辑图表';
          img.onclick = function() {
            context.ui.panels.open('drawio-editor', { state: { xml: xml } });
          };
          container.appendChild(img);
          return function() { img.remove(); };
        }

        // Placeholder
        var placeholder = document.createElement('div');
        placeholder.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:150px;border:1px dashed var(--color-border,#e2e8f0);border-radius:8px;padding:20px;text-align:center;cursor:pointer;';
        placeholder.innerHTML =
          '<div style="font-size:40px;margin-bottom:10px;">📊</div>' +
          '<div style="font-size:14px;color:var(--color-muted,#64748b);margin-bottom:5px;">draw.io 流程图</div>' +
          '<div style="font-size:12px;color:var(--color-muted,#94a3b8);">点击此处创建或编辑</div>';
        placeholder.onclick = function() {
          context.ui.panels.open('drawio-editor');
        };
        container.appendChild(placeholder);
        return function() { placeholder.remove(); };
      } catch (e) {
        console.error('Embed render error:', e);
        return function() {};
      }
    }
  };

  // ============================================================
  // Register with EdgeEver
  // ============================================================
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { activate: DrawioPlugin.activate };
  }
  if (typeof define === 'function' && define.amd) {
    define(function() { return { activate: DrawioPlugin.activate }; });
  }
  self.DrawioPlugin = DrawioPlugin;
})();
