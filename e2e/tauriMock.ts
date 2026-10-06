/**
 * Browser-side stand-in for the Tauri IPC layer, injected before the app loads.
 * Produces deterministic synthetic images so canvas output can be asserted pixel by pixel.
 *
 * Source image: 1200x800 (working size 600x400). Blue background, orange disc centred at
 * (600, 400) source px with radius 240. The mask is the same disc (white on black).
 */
export interface MockOptions {
  /** Version the fake update server announces (null = already up to date). */
  updateVersion?: string | null;
  /** A project the OS launched the app with (double-click). */
  launchFile?: string;
  /** Inject failures: command name -> typed error thrown by that command. */
  errors?: Record<string, { code: string; message: string }>;
  /** Make `import_images` reject the picked file as unsupported. */
  rejectImport?: boolean;
  /** Working size of the preview/mask (default 600x400). Use 2048x1536 to measure editor performance. */
  work?: [number, number];
  /** Source image size (default 1200x800). */
  source?: [number, number];
  /** Image ids whose export/removal fails (to test per-item errors). */
  failIds?: string[];
  /** Milliseconds per simulated job step. */
  tickMs?: number;
  /** Autosaves that exist when the app starts (crash recovery). */
  recovery?: unknown[];
}

export function installTauriMock(options: MockOptions = {}) {
  const [W, H] = options.work ?? [600, 400];
  const [SW, SH] = options.source ?? [1200, 800];
  const callbacks = new Map<number, unknown>();
  const state = {
    hasMask: false,
    runs: 0,
    imports: 0,
    calls: [] as string[],
    /** Fake disk: path -> saved project. */
    files: {} as Record<string, { payload: any; meta: any }>,
    autosaves: [] as any[],
    savePath: '/docs/test.photom',
    openPath: '/docs/test.photom',
    settings: {
      schemaVersion: 1,
      theme: 'light',
      autosaveSeconds: 60,
      recentProjectsLimit: 10,
      defaultExportFolder: null,
      modelType: 'fast',
      processing: 'cpu',
      shortcuts: {},
      exportPresets: [],
      defaultPreset: null,
      lastUsedFolders: {},
      undoDepth: 50,
      pixelLimitMp: 100,
      embedOriginals: true,
      recentProjects: [],
    } as any,
    recovery: (options.recovery ?? []) as any[],
    /** Fake export/removal jobs advanced by a timer. */
    jobs: {} as Record<string, any>,
    jobSeq: 0,
    failIds: (options.failIds ?? []) as string[],
    tickMs: options.tickMs ?? 120,
    exports: [] as any[],
    history: [] as any[],
    clipboard: [] as any[],
  };
  // The real backend returns fresh JSON every time; never hand out live references.
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const listeners: Record<string, number[]> = {};
  (window as unknown as Record<string, unknown>).__emit = (event: string, payload: unknown) =>
    emit(event, payload);
  const emit = (event: string, payload: unknown) => {
    for (const id of listeners[event] ?? []) {
      const cb = callbacks.get(id) as ((e: unknown) => void) | undefined;
      cb?.({ event, id, payload });
    }
  };
  (window as unknown as Record<string, unknown>).__mock = state;

  const png = async (draw: (c: OffscreenCanvasRenderingContext2D) => void) => {
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d')!;
    draw(ctx);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  };
  const disc = (ctx: OffscreenCanvasRenderingContext2D, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, H * 0.3, 0, Math.PI * 2);
    ctx.fill();
  };

  const meta = (n: number) => ({
    id: `img${n}`,
    path: `/fake/photo${n}.jpg`,
    name: `photo${n}.jpg`,
    width: SW,
    height: SH,
    format: 'jpeg',
    thumbnailPath: `/cache/thumbs/img${n}.png`,
  });
  const maskResult = (n: number) => ({
    id: `img${n}`,
    maskPath: `/cache/masks/img${n}-${state.runs}.png`,
    width: SW,
    height: SH,
    boundingBox: { x: 360, y: 160, width: 480, height: 480 },
    durationMs: 900,
    device: 'cpu',
  });

  const opened = (payload: any, hasMask: boolean, path: string | null) => {
    state.hasMask = hasMask;
    return {
      meta: {
        projectId: payload.projectId,
        name: payload.name,
        path,
        modified: 't',
        formatVersion: 1,
        activeId: payload.activeId,
      },
      images: payload.images.map((i: any) => ({
        meta: meta(Number(String(i.id).replace('img', ''))),
        state: i.state,
        mask: hasMask ? maskResult(Number(String(i.id).replace('img', ''))) : null,
      })),
      warnings: [],
    };
  };

  const snapshot = (j: any) => {
    const done = j.items.filter((i: any) => i.status === 'done' || i.status === 'failed').length;
    return {
      jobId: j.id,
      kind: j.kind,
      status: j.status,
      done,
      total: j.items.length,
      items: j.items.map((i: any) => ({ ...i })),
    };
  };
  const progress = (j: any, current: string | null) => {
    const sn = snapshot(j);
    emit('job:progress', {
      jobId: j.id,
      done: sn.done,
      total: sn.total,
      currentId: current,
      state: j.status,
    });
  };
  const startJob = (kind: string, ids: string[], options: any) => {
    const id = `job-${++state.jobSeq}`;
    const j: any = {
      id,
      kind,
      status: 'running',
      cancelled: false,
      options,
      items: ids.map((i) => ({
        id: i,
        label: `photo${i.replace('img', '')}.jpg`,
        status: 'queued',
        error: null,
        result: null,
      })),
    };
    state.jobs[id] = j;
    const finish = () => {
      clearInterval(timer);
      for (const it of j.items) if (it.status === 'queued') it.status = 'cancelled';
      j.status = j.cancelled ? 'cancelled' : 'done';
      progress(j, null);
    };
    const timer = setInterval(() => {
      if (j.status === 'paused') return;
      if (j.cancelled) return finish();
      const running = j.items.find((i: any) => i.status === 'processing');
      if (running) {
        if (state.failIds.includes(running.id)) {
          running.status = 'failed';
          running.error = {
            code: 'ExportFailed',
            message: 'Remove the background of this image before exporting it.',
          };
          emit('job:error', { jobId: id, itemId: running.id, error: running.error });
        } else {
          running.status = 'done';
          if (kind === 'export') {
            const n = j.items.indexOf(running) + 1;
            const out = `${options.folder}/photo${running.id.replace('img', '')}-photom.png`;
            running.result = {
              id: running.id,
              outputPath: out,
              width: 800,
              height: 600,
              bytes: 1234,
            };
            state.history.unshift({
              id: `h${state.history.length + 1}`,
              kind: 'export',
              name: running.label,
              timestamp: new Date().toISOString(),
              sourcePath: `/fake/${running.label}`,
              outputPath: out,
              thumbnail: null,
            });
            void n;
          } else {
            state.hasMask = true;
            state.runs++;
            running.result = maskResult(Number(running.id.replace('img', '')));
          }
          emit('job:item-complete', { jobId: id, itemId: running.id, result: running.result });
        }
        return progress(j, null);
      }
      const next = j.items.find((i: any) => i.status === 'queued');
      if (!next) return finish();
      next.status = 'processing';
      progress(j, next.id);
    }, state.tickMs);
    return id;
  };

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    get_model_status: () => ({
      ready: true,
      state: 'idle',
      activeModel: 'fast',
      device: 'cpu',
      path: '/m',
      message: null,
    }),
    'plugin:dialog|open': (a) => {
      const o = (a.options ?? {}) as { directory?: boolean; filters?: { extensions: string[] }[] };
      const ext = o.filters?.[0]?.extensions ?? [];
      if (o.directory) return '/fake';
      if (ext.includes('photom')) return state.openPath;
      if (ext.includes('onnx')) return '/downloads/model.onnx';
      return [`/fake/photo${++state.imports}.jpg`];
    },
    'plugin:dialog|save': () => state.savePath,
    take_launch_file: () => options.launchFile ?? null,
    check_for_update: () => {
      const v = options.updateVersion ?? null;
      return {
        available: v !== null,
        currentVersion: '0.1.0',
        version: v,
        notes: v ? 'Faster exports.\nNew icon.' : null,
        date: null,
      };
    },
    install_update: async () => {
      emit('update:progress', { downloaded: 50, total: 100 });
      await new Promise((r) => setTimeout(r, 150));
      emit('update:progress', { downloaded: 100, total: 100 });
      return null;
    },
    restart_app: () => null,
    read_licences: () =>
      '# Third-party licences\n\n| react | 18.3.1 | MIT |\n\nMIT License\n\nCopyright (c) Meta',
    get_settings: () => clone(state.settings),
    update_settings: (a) => {
      state.settings = clone(a.settings);
      return clone(state.settings);
    },
    get_app_info: () => ({
      version: '0.1.0',
      logsDir: '/logs',
      models: [
        {
          kind: 'fast',
          fileName: 'isnet-general-use.onnx',
          licence: 'Apache-2.0',
          present: true,
          path: '/m',
        },
      ],
    }),
    paths_exist: (a) => (a.paths as string[]).map((p) => p in state.files),
    remove_recent_project: (a) => {
      state.settings.recentProjects = state.settings.recentProjects.filter(
        (r: any) => r.path !== a.path,
      );
      return state.settings;
    },
    clear_recent_projects: () => {
      state.settings.recentProjects = [];
      return state.settings;
    },
    reset_session: () => {
      state.hasMask = false;
      return null;
    },
    save_project: (a) => {
      const payload = a.payload as any;
      const path = a.path as string;
      const name = path
        .split('/')
        .pop()!
        .replace(/\.photom$/, '');
      const meta = {
        projectId: payload.projectId,
        name,
        path,
        modified: new Date().toISOString(),
        formatVersion: 1,
        activeId: payload.activeId,
      };
      state.files[path] = { payload, meta: { ...meta, hasMask: state.hasMask } };
      state.settings.recentProjects = [
        { path, name, modified: meta.modified, thumbnail: null },
        ...state.settings.recentProjects.filter((r: any) => r.path !== path),
      ];
      return meta;
    },
    open_project: (a) => {
      const f = state.files[a.path as string];
      if (!f) throw { code: 'InvalidInput', message: `file not found: ${a.path}`, details: null };
      return opened(f.payload, f.meta.hasMask, a.path as string);
    },
    project_backup_path: () => null,
    autosave_project: (a) => {
      state.autosaves.push(a.payload);
      return new Date().toISOString();
    },
    list_recovery: () => state.recovery.map((r: any) => r.entry),
    restore_recovery: (a) => {
      const r = state.recovery.find((x: any) => x.entry.id === a.id);
      return opened(r.payload, r.hasMask, null);
    },
    discard_recovery: (a) => {
      state.recovery = state.recovery.filter((x: any) => x.entry.id !== a.id);
      return null;
    },
    import_images: () =>
      options.rejectImport
        ? {
            images: [],
            rejected: [
              {
                path: '/fake/notes.txt',
                reason: 'Unsupported file type. Use PNG, JPG, WEBP, BMP or TIFF.',
              },
            ],
          }
        : { images: [meta(state.imports)], rejected: [] },
    prepare_working_set: (a) => ({
      id: a.id,
      previewPath: '/cache/work/preview.png',
      maskPath: state.hasMask ? '/cache/work/mask.png' : null,
      workWidth: W,
      workHeight: H,
      sourceWidth: SW,
      sourceHeight: SH,
    }),
    read_cache_file: async (a) =>
      String(a.path).includes('mask')
        ? png((ctx) => {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
            disc(ctx, '#fff');
          })
        : png((ctx) => {
            ctx.fillStyle = '#2060c0';
            ctx.fillRect(0, 0, W, H);
            disc(ctx, '#e07020');
          }),
    remove_background: async (a) => {
      await new Promise((r) => setTimeout(r, 80));
      state.hasMask = true;
      state.runs++;
      return maskResult(Number(String(a.id).replace('img', '')));
    },
    set_active_mask: (a) => {
      state.hasMask = a.maskPath !== null;
      return null;
    },
    export_png: (a) => {
      const items = a.items as any[];
      const options = a.options as any;
      state.exports.push({ items, options });
      return startJob(
        'export',
        items.map((i) => i.id),
        options,
      );
    },
    remove_background_batch: (a) => startJob('removeBackground', a.ids as string[], null),
    get_job: (a) => {
      const j = state.jobs[a.jobId as string];
      if (!j) throw { code: 'InvalidInput', message: 'unknown job', details: null };
      return snapshot(j);
    },
    pause_job: (a) => {
      const j = state.jobs[a.jobId as string];
      if (j.status === 'running') j.status = 'paused';
      return null;
    },
    resume_job: (a) => {
      const j = state.jobs[a.jobId as string];
      if (j.status === 'paused') j.status = 'running';
      return null;
    },
    cancel_job: (a) => {
      state.jobs[a.jobId as string].cancelled = true;
      return null;
    },
    copy_to_clipboard: (a) => {
      state.clipboard.push(a);
      return null;
    },
    list_history: () => state.history,
    delete_history_item: (a) => {
      state.history = state.history.filter((h: any) => h.id !== a.id);
      return state.history;
    },
    clear_history: () => {
      state.history = [];
      return state.history;
    },
    list_export_presets: () => state.settings.exportPresets,
    save_export_preset: (a) => {
      const p = { ...(a.preset as any) };
      p.id = p.id || `preset-${state.settings.exportPresets.length + 1}`;
      const i = state.settings.exportPresets.findIndex((x: any) => x.id === p.id);
      if (i >= 0) state.settings.exportPresets[i] = p;
      else state.settings.exportPresets.push(p);
      return clone(state.settings.exportPresets);
    },
    delete_export_preset: (a) => {
      state.settings.exportPresets = state.settings.exportPresets.filter((x: any) => x.id !== a.id);
      return state.settings.exportPresets;
    },
    reveal_in_folder: () => {
      state.calls.push('reveal');
      return null;
    },
    reveal_path: (a) => {
      state.calls.push(`reveal_path:${a.path}`);
      return null;
    },
    'plugin:window|is_maximized': () => false,
    'plugin:event|listen': (a) => {
      (listeners[a.event as string] ??= []).push(a.handler as number);
      return 1;
    },
    'plugin:event|unlisten': () => null,
  };

  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    transformCallback: (cb: unknown) => {
      const id = Math.floor(Math.random() * 1e9);
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: () =>
      'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      state.calls.push(cmd);
      const injected = options.errors?.[cmd];
      if (injected) throw { ...injected, details: null };
      const h = handlers[cmd];
      return h ? h(args) : null;
    },
  };
}
