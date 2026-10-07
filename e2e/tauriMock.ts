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
  /** Show the first-run model offer (default: already answered, so it stays out of the way). */
  onboarding?: boolean;
  /** Model Hub behaviour. */
  hub?: {
    /** Model ids that are listed but cannot be downloaded yet. */
    unpublished?: string[];
    /** Model id -> error code its first install attempt fails with. */
    failFirst?: Record<string, string>;
    /** Pretend the catalog server is unreachable. */
    offline?: boolean;
    /** Milliseconds per 10% of a download. */
    stepMs?: number;
  };
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
    /** Upscale simulation: results waiting for a decision, and kept ones, by image id. */
    upscale: {
      pending: {} as Record<string, any>,
      kept: {} as Record<string, any>,
      runs: [] as any[],
      batches: [] as any[],
      cancelled: [] as string[],
    },
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
      shadowPresets: [],
      defaultPreset: null,
      lastUsedFolders: {},
      undoDepth: 50,
      pixelLimitMp: 100,
      upscaleMaxMp: 100,
      embedOriginals: true,
      recentProjects: [],
      modelsOnboardingDone: !options.onboarding,
      modelsCatalogUrl: null,
      modelsExtraHost: null,
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

  const png = async (
    draw: (c: OffscreenCanvasRenderingContext2D) => void,
    size: [number, number] = [W, H],
  ) => {
    const c = new OffscreenCanvas(size[0], size[1]);
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
        upscaled: i.state?.upscale
          ? {
              path: `/cache/upscale/${i.id}/kept.png`,
              width: i.state.upscale.width,
              height: i.state.upscale.height,
              scale: i.state.upscale.scale,
              engine: i.state.upscale.engine,
            }
          : null,
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
            message:
              kind === 'upscale' || kind === 'upscaleBatch'
                ? 'The image could not be decoded.'
                : 'Remove the background of this image before exporting it.',
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
          } else if (kind === 'upscale') {
            const p = options.params;
            const [sw, sh] = [SW, SH];
            const out = p.target ? [p.target.width, p.target.height] : [sw * p.scale, sh * p.scale];
            running.result = {
              id: running.id,
              path: `/cache/upscale/${running.id}/pending-${state.upscale.runs.length + 1}.png`,
              width: out[0],
              height: out[1],
              scale: p.target ? null : p.scale,
              engine: p.engine,
            };
            state.upscale.pending[running.id] = running.result;
          } else if (kind === 'upscaleBatch') {
            const p = options.params;
            const kept = {
              path: `/cache/upscale/${running.id}/kept_${p.scale}x.png`,
              width: SW * p.scale,
              height: SH * p.scale,
              scale: p.scale,
              engine: p.engine,
            };
            state.upscale.kept[running.id] = kept;
            state.upscale.batches.push({ id: running.id, params: p });
            running.result = { id: running.id, kept };
          } else if (kind === 'applyShadow') {
            running.result = {
              id: running.id,
              applied: true,
              frame: { x: 0, y: 0, w: 1300, h: 900 },
              ground: 640,
            };
            if (j.items.every((i: any) => i.status !== 'queued')) {
              const n = j.items.filter((i: any) => i.status === 'done').length;
              state.history.unshift({
                id: `h${state.history.length + 1}`,
                kind: 'shadow',
                name: `Shadow applied to ${n} image${n === 1 ? '' : 's'}`,
                timestamp: new Date().toISOString(),
                sourcePath: null,
                outputPath: null,
                thumbnail: null,
              });
            }
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

  // ---- Model Hub simulation -------------------------------------------------------------
  const MB = 1_000_000;
  const hubOpts = options.hub ?? {};
  const mkModel = (
    id: string,
    name: string,
    feature: string,
    mb: number,
    recommended: boolean,
  ) => ({
    id,
    name,
    feature,
    version: '1.0.0',
    description: `${name} (test model).`,
    sizeBytes: mb * MB,
    sha256: 'ab'.repeat(32),
    license: {
      name: 'Apache-2.0',
      url: 'https://example.org/licence',
      commercialUse: true,
      attribution: 'Test attribution',
    },
    requirements: { minRamMb: 2048, gpuOptional: true },
    recommended,
    dependsOn: [] as string[],
    state: { kind: 'notInstalled' } as any,
    installedVersion: null as string | null,
    source: null as string | null,
    verified: false,
    installable: !(hubOpts.unpublished ?? []).includes(id),
    removable: false,
  });
  const hubModels: any[] = [
    mkModel('bgremoval-fast', 'Background Remover (Fast)', 'background-removal', 90, true),
    mkModel('bgremoval-quality', 'Background Remover (Quality)', 'background-removal', 120, false),
    mkModel('text-detector', 'Text Detector', 'text-removal', 60, true),
    mkModel('inpaint-lama', 'Inpainting (LaMa)', 'text-removal', 200, true),
    mkModel('upscale-x2', 'Upscaler x2', 'upscale', 65, true),
  ];
  Object.assign(hubModels[0], {
    state: { kind: 'installed' },
    installedVersion: '1.0.0',
    source: 'bundled',
    verified: true,
    installable: false,
  });
  const hubById = (id: string) => hubModels.find((m) => m.id === id);
  const hubSetState = (m: any, st: any) => {
    m.state = st;
    emit('model:state', { id: m.id, state: st });
  };
  const hubTimers: Record<string, number> = {};
  const hubDone: Record<string, number> = {};
  const failedOnce = new Set<string>();
  const hubQueue: string[] = [];
  let hubBusy = false;
  const hubPump = () => {
    if (hubBusy) return;
    const id = hubQueue.shift();
    if (!id) return;
    hubBusy = true;
    const m = hubById(id);
    hubSetState(m, { kind: 'downloading' });
    const step = hubOpts.stepMs ?? 60;
    const total = m.sizeBytes;
    const tick = () => {
      const code = hubOpts.failFirst?.[id];
      if (code && !failedOnce.has(id) && (hubDone[id] ?? 0) >= total * 0.3) {
        failedOnce.add(id);
        hubBusy = false;
        hubSetState(m, { kind: 'failed', code, message: 'simulated' });
        hubPump();
        return;
      }
      hubDone[id] = Math.min(total, (hubDone[id] ?? 0) + total / 10);
      emit('model:progress', {
        id,
        downloadedBytes: hubDone[id],
        totalBytes: total,
        speedBps: 6_200_000,
        etaSeconds: Math.round((total - hubDone[id]) / 6_200_000),
      });
      if (hubDone[id] < total) {
        hubTimers[id] = window.setTimeout(tick, step);
        return;
      }
      hubSetState(m, { kind: 'verifying' });
      hubTimers[id] = window.setTimeout(() => {
        hubSetState(m, { kind: 'installing' });
        hubTimers[id] = window.setTimeout(() => {
          Object.assign(m, {
            installedVersion: m.version,
            source: 'hub',
            verified: true,
            removable: true,
          });
          hubSetState(m, { kind: 'installed' });
          hubBusy = false;
          hubPump();
        }, step);
      }, step);
    };
    hubTimers[id] = window.setTimeout(tick, step);
  };
  const hubInstall = (id: string) => {
    const m = hubById(id);
    if (!m) throw { code: 'InvalidInput', message: `unknown model ${id}`, details: null };
    if (['queued', 'downloading', 'verifying', 'installing', 'installed'].includes(m.state.kind))
      return;
    if (!m.installable) {
      throw {
        code: 'InvalidInput',
        message: `${m.name} is not available for download yet`,
        details: null,
      };
    }
    hubSetState(m, { kind: 'queued' });
    hubQueue.push(id);
    hubPump();
  };
  const hubWanted = (all: boolean) =>
    hubModels.filter(
      (m) => (all || m.recommended) && m.installable && m.state.kind === 'notInstalled',
    );
  const hubHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    models_list: () => clone(hubModels),
    model_catalog_status: () => ({
      source: 'bundled',
      generatedAt: '2026-01-01T00:00:00Z',
      warning: null,
    }),
    models_refresh_catalog: () => ({
      models: clone(hubModels),
      source: hubOpts.offline ? 'bundled' : 'remote',
      generatedAt: '2026-01-01T00:00:00Z',
      warning: hubOpts.offline ? 'You are offline or the catalog server is unreachable.' : null,
    }),
    model_install: (a) => hubInstall(a.id as string),
    model_install_many: (a) => {
      const ids = a.ids as string[];
      ids.forEach(hubInstall);
      return ids.length;
    },
    model_install_recommended: () => {
      const w = hubWanted(false);
      w.forEach((m) => hubInstall(m.id));
      return w.length;
    },
    model_install_all: () => {
      const w = hubWanted(true);
      w.forEach((m) => hubInstall(m.id));
      return w.length;
    },
    model_pause: (a) => {
      const m = hubById(a.id as string);
      if (m.state.kind === 'queued') {
        hubQueue.splice(hubQueue.indexOf(m.id), 1);
        hubSetState(m, { kind: 'paused' });
      } else if (m.state.kind === 'downloading') {
        window.clearTimeout(hubTimers[m.id]);
        hubBusy = false;
        hubSetState(m, { kind: 'paused' });
        hubPump();
      }
      return null;
    },
    model_resume: (a) => {
      const m = hubById(a.id as string);
      if (m.state.kind === 'paused') {
        hubSetState(m, { kind: 'queued' });
        hubQueue.push(m.id);
        hubPump();
      }
      return null;
    },
    model_cancel: (a) => {
      const m = hubById(a.id as string);
      window.clearTimeout(hubTimers[m.id]);
      const i = hubQueue.indexOf(m.id);
      if (i >= 0) hubQueue.splice(i, 1);
      if (m.state.kind === 'downloading') hubBusy = false;
      hubDone[m.id] = 0;
      hubSetState(m, { kind: 'notInstalled' });
      hubPump();
      return null;
    },
    model_import_file: (a) => {
      const m = hubById(a.id as string);
      state.calls.push(`import:${a.path}:${a.allowUnverified ? 'allow' : 'strict'}`);
      if (!m) throw { code: 'InvalidInput', message: 'unknown model', details: null };
      // Files named "official-*" match the published checksum; anything else is unverified.
      const verified = String(a.path).includes('official-');
      if (!verified && !a.allowUnverified) {
        throw { code: 'Unverified', message: 'Unverified file: no match', details: null };
      }
      Object.assign(m, {
        installedVersion: m.version,
        source: 'imported',
        verified,
        removable: true,
      });
      hubSetState(m, { kind: 'installed' });
      return null;
    },
    model_remove: (a) => {
      const m = hubById(a.id as string);
      state.calls.push(`remove:${a.id}`);
      hubSetState(m, { kind: 'removing' });
      Object.assign(m, { installedVersion: null, source: null, verified: false, removable: false });
      hubDone[m.id] = 0;
      hubSetState(m, { kind: 'notInstalled' });
      return null;
    },
    model_open_folder: () => {
      state.calls.push('model_open_folder');
      return null;
    },
  };

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    ...hubHandlers,
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
      if (ext.includes('onnx')) return (state as any).importPath ?? '/downloads/model.onnx';
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
    upscale_estimate: (a) => {
      const p = (a.params as any) ?? {};
      if (!p.scale && !p.target)
        throw { code: 'InvalidInput', message: 'Choose a scale or a target size.', details: null };
      if (p.target && p.target.width <= SW && p.target.height <= SH)
        throw {
          code: 'InvalidInput',
          message: 'The target size must be larger than the image.',
          details: null,
        };
      const [ow, oh] = p.target ? [p.target.width, p.target.height] : [SW * p.scale, SH * p.scale];
      const mp = (ow * oh) / 1e6;
      const warnings: any[] = [];
      if (mp > 100)
        warnings.push({
          code: 'too-large',
          blocking: true,
          message: `The result would be ${mp.toFixed(1)} MP; the limit is 100 MP. Choose a smaller scale or target, or raise the limit in Settings.`,
        });
      if (Math.max(SW, SH) >= 3000)
        warnings.push({
          code: 'already-large',
          blocking: false,
          message: 'This image is already high resolution. Upscale anyway?',
        });
      return {
        outW: ow,
        outH: oh,
        megapixels: mp,
        etaSeconds: Math.ceil(mp * 0.07 * 10) / 10,
        memoryMb: Math.ceil((ow * oh * 14 + SW * SH * 8) / 1e6),
        warnings,
      };
    },
    upscale_requirements: () => ({ ready: false, missing: [] }),
    upscale_run: (a) => {
      const params = a.params as any;
      state.upscale.runs.push({ id: a.imageId, params });
      return startJob('upscale', [a.imageId as string], { params });
    },
    upscale_accept: (a) => {
      const p = state.upscale.pending[a.imageId as string];
      if (!p)
        throw {
          code: 'InvalidInput',
          message: 'There is no upscaled result to keep.',
          details: null,
        };
      delete state.upscale.pending[a.imageId as string];
      const kept = {
        path: `/cache/upscale/${a.imageId}/kept.png`,
        width: p.width,
        height: p.height,
        scale: p.scale,
        engine: p.engine,
      };
      state.upscale.kept[a.imageId as string] = kept;
      state.history.unshift({
        id: `h${state.history.length + 1}`,
        kind: 'upscale',
        name: `${a.imageId} upscaled to ${p.width} x ${p.height}`,
        timestamp: new Date().toISOString(),
        sourcePath: null,
        outputPath: null,
        thumbnail: null,
      });
      return kept;
    },
    upscale_cancel: (a) => {
      (state.upscale.cancelled ??= []).push(a.imageId);
      return null;
    },
    upscale_batch: (a) => {
      const params = a.params as any;
      if (!(a.imageIds as string[]).length || params.target)
        throw {
          code: 'InvalidInput',
          message: 'A batch upscales by 2x or 4x; a target size applies to one image.',
          details: null,
        };
      return startJob('upscaleBatch', a.imageIds as string[], { params });
    },
    upscale_discard: (a) => {
      delete state.upscale.pending[a.imageId as string];
      if (a.includeKept) delete state.upscale.kept[a.imageId as string];
      return null;
    },
    upscale_loupe: () =>
      png(
        (ctx) => {
          ctx.fillStyle = '#c04020';
          ctx.fillRect(0, 0, 128, 128);
          ctx.fillStyle = '#20a040';
          ctx.fillRect(128, 0, 128, 128);
        },
        [256, 128],
      ),
    read_cache_file: async (a) =>
      String(a.path).includes('pending') || String(a.path).includes('kept')
        ? png(
            (ctx) => {
              ctx.fillStyle = '#d0d030';
              ctx.fillRect(0, 0, W * 2, H * 2);
            },
            [W * 2, H * 2],
          )
        : String(a.path).includes('mask')
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
    shadow_apply_batch: (a) => {
      const items = a.items as any[];
      state.shadowBatches = [...(state.shadowBatches ?? []), { items, label: a.label }];
      return startJob(
        'applyShadow',
        items.map((i) => i.id),
        null,
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
    list_shadow_presets: () => state.settings.shadowPresets,
    save_shadow_preset: (a) => {
      const p = { ...(a.preset as any) };
      p.id = p.id || `shadow-preset-${state.settings.shadowPresets.length + 1}`;
      const i = state.settings.shadowPresets.findIndex((x: any) => x.id === p.id);
      if (i >= 0) state.settings.shadowPresets[i] = p;
      else state.settings.shadowPresets.push(p);
      return clone(state.settings.shadowPresets);
    },
    delete_shadow_preset: (a) => {
      state.settings.shadowPresets = state.settings.shadowPresets.filter((x: any) => x.id !== a.id);
      return clone(state.settings.shadowPresets);
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
