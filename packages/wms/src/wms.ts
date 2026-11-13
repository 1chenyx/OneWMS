import type Database from 'better-sqlite3';
import {
  ensureProjectionVersion,
  OneCore,
  type EventsView,
  type FieldsView,
  type ModuleManifest,
  type ModulesView,
  type ProfileView,
  type ToolsView,
  type DynView,
  type WorkspaceFacade,
} from '@one/core';
import { migrateWms } from './db/migrations.js';
import { SkuView } from './views/sku-view.js';
import { LocationView } from './views/location-view.js';
import { PartnerView } from './views/partner-view.js';
import { OrderView } from './views/order-view.js';
import { InventoryView } from './views/inventory-view.js';
import { StocktakeView } from './views/stocktake-view.js';
import { PickingView } from './views/picking-view.js';
import { WaveView } from './views/wave-view.js';
import { WmsProjections, WMS_PROJECTION_GROUP } from './views/wms-projections.js';
import { createWmsTools } from './tools/wms-tools.js';
import { createPutawayTools } from './tools/putaway-tools.js';
import { isWmsEventType } from './events/catalog.js';
import { wmsManifest } from './wms-manifest.js';
import { inboundPutawayPatch, putawayManifest } from './putaway-manifest.js';
import { reversalManifest } from './reversal-manifest.js';
import { partialManifest } from './partial-manifest.js';
import { reservationManifest } from './reservation-manifest.js';
import { returnManifest } from './return-manifest.js';
import { asnManifest } from './asn-manifest.js';
import { outboundPickedPatch, outboundPickingPatch, pickingManifest } from './picking-manifest.js';
import { qcManifest } from './qc-manifest.js';
import { waveManifest } from './wave-manifest.js';
import { packManifest } from './pack-manifest.js';
import { loadManifest } from './load-manifest.js';
import { reviewManifest } from './review-manifest.js';
import { replenishManifest } from './replenish-manifest.js';
import { createReplenishTools } from './tools/replenish-tools.js';
import { warehouseManifest } from './warehouse-manifest.js';
import { createWarehouseTools } from './tools/warehouse-tools.js';
import { zoneManifest } from './zone-manifest.js';
import { createZoneTools } from './tools/zone-tools.js';
import { WarehouseView } from './views/warehouse-view.js';
import { ZoneView } from './views/zone-view.js';
import { serialManifest } from './serial-manifest.js';
import { createSerialTools } from './tools/serial-tools.js';
import { SerialView } from './views/serial-view.js';
import { lpnManifest } from './lpn-manifest.js';
import { createLpnTools } from './tools/lpn-tools.js';
import { createTransferTools } from './tools/transfer-tools.js';
import { createScrapTools } from './tools/scrap-tools.js';
import { LpnView } from './views/lpn-view.js';
import { TransferView } from './views/transfer-view.js';
import { ScrapView } from './views/scrap-view.js';
import { ReportView } from './views/report-view.js';
import { IntegrationCodeView } from './views/integration-code-view.js';
import { reportManifest } from './report-manifest.js';
import { createReportTools } from './tools/report-tools.js';

/**
 * WmsDomain —— 领域装配器：把仓储领域「挂载」到一个内核实例上。
 *
 * 装配动作（attach 一次完成）：
 *  1. 建领域表（wms_* 前缀，与内核表同居一库）；
 *  2. 向工具总线注册 wms.* 工具（进程级一次，全工作区共享）；
 *  3. 从工具定义派生 core.wms manifest 并注册进进程目录（M6：声明面与事实面零重复）。
 * 领域包只经 @one/core 的公共 API + 领域装配口（exposeDb/exposeToolBus/exposeModuleRegistry）触碰内核。
 */
export class WmsDomain {
  readonly #core: OneCore;
  readonly #db: Database.Database;
  readonly #manifest: ModuleManifest;
  readonly #putawayManifest: ModuleManifest;
  readonly #reversalManifest: ModuleManifest;
  readonly #partialManifest: ModuleManifest;
  readonly #reservationManifest: ModuleManifest;
  readonly #returnManifest: ModuleManifest;
  readonly #asnManifest: ModuleManifest;
  readonly #replenishManifest: ModuleManifest;
  readonly #warehouseManifest: ModuleManifest;
  readonly #zoneManifest: ModuleManifest;
  readonly #serialManifest: ModuleManifest;
  readonly #lpnManifest: ModuleManifest;
  readonly #pickingManifest: ModuleManifest;
  readonly #qcManifest: ModuleManifest;
  readonly #waveManifest: ModuleManifest;
  readonly #packManifest: ModuleManifest;
  readonly #loadManifest: ModuleManifest;
  readonly #reviewManifest: ModuleManifest;
  readonly #reportManifest: ModuleManifest;
  readonly #cache = new Map<string, WmsWorkspace>();

  private constructor(core: OneCore) {
    this.#core = core;
    this.#db = core.exposeDb();
    migrateWms(this.#db);
    const bus = core.exposeToolBus();
    // 工具 partition（M21）：putaway 工具注册上总线（AI 可用），但不进
    // core.wms 的 tools 数组——它由 module.putaway manifest 单独声明（双声明冲突）
    const toolDefs = createWmsTools((id) => this.workspace(id));
    const putawayToolDefs = createPutawayTools((id) => this.workspace(id));
    const replenishToolDefs = createReplenishTools((id) => this.workspace(id));
    const warehouseToolDefs = createWarehouseTools((id) => this.workspace(id));
    const zoneToolDefs = createZoneTools((id) => this.workspace(id));
    const serialToolDefs = createSerialTools((id) => this.workspace(id));
    const lpnToolDefs = createLpnTools((id) => this.workspace(id));
    const transferToolDefs = createTransferTools((id) => this.workspace(id));
    const scrapToolDefs = createScrapTools((id) => this.workspace(id));
    const reportToolDefs = createReportTools((id) => this.workspace(id));
    for (const tool of [
      ...toolDefs,
      ...putawayToolDefs,
      ...replenishToolDefs,
      ...warehouseToolDefs,
      ...zoneToolDefs,
      ...serialToolDefs,
      ...lpnToolDefs,
      ...transferToolDefs,
      ...scrapToolDefs,
      ...reportToolDefs,
    ]) {
      bus.register(tool);
    }
    this.#manifest = wmsManifest(toolDefs);
    this.#putawayManifest = putawayManifest(putawayToolDefs);
    this.#reversalManifest = reversalManifest();
    this.#partialManifest = partialManifest();
    this.#reservationManifest = reservationManifest();
    this.#returnManifest = returnManifest();
    this.#asnManifest = asnManifest();
    this.#replenishManifest = replenishManifest(replenishToolDefs);
    this.#warehouseManifest = warehouseManifest(warehouseToolDefs);
    this.#zoneManifest = zoneManifest(zoneToolDefs);
    this.#serialManifest = serialManifest(serialToolDefs);
    this.#lpnManifest = lpnManifest(lpnToolDefs);
    this.#pickingManifest = pickingManifest();
    this.#qcManifest = qcManifest();
    this.#waveManifest = waveManifest();
    this.#packManifest = packManifest();
    this.#loadManifest = loadManifest();
    this.#reviewManifest = reviewManifest();
    this.#reportManifest = reportManifest(reportToolDefs);
    core.exposeModuleRegistry().registerManifest(this.#manifest);
    core.exposeModuleRegistry().registerManifest(this.#putawayManifest);
    core.exposeModuleRegistry().registerManifest(this.#reversalManifest);
    core.exposeModuleRegistry().registerManifest(this.#partialManifest);
    core.exposeModuleRegistry().registerManifest(this.#reservationManifest);
    core.exposeModuleRegistry().registerManifest(this.#returnManifest);
    core.exposeModuleRegistry().registerManifest(this.#asnManifest);
    core.exposeModuleRegistry().registerManifest(this.#replenishManifest);
    core.exposeModuleRegistry().registerManifest(this.#warehouseManifest);
    core.exposeModuleRegistry().registerManifest(this.#zoneManifest);
    core.exposeModuleRegistry().registerManifest(this.#serialManifest);
    core.exposeModuleRegistry().registerManifest(this.#lpnManifest);
    core.exposeModuleRegistry().registerManifest(this.#pickingManifest);
    core.exposeModuleRegistry().registerManifest(this.#qcManifest);
    core.exposeModuleRegistry().registerManifest(this.#waveManifest);
    core.exposeModuleRegistry().registerManifest(this.#packManifest);
    core.exposeModuleRegistry().registerManifest(this.#loadManifest);
    core.exposeModuleRegistry().registerManifest(this.#reviewManifest);
    core.exposeModuleRegistry().registerManifest(this.#reportManifest);
  }

  /** 把领域挂到内核上（幂等心智：attach 两次 = 工具覆盖注册 + 表 IF NOT EXISTS + 目录覆盖登记） */
  static attach(core: OneCore): WmsDomain {
    return new WmsDomain(core);
  }

  /** 获取（或创建）工作区绑定门面——同 workspaceId 恒返回同一实例（游标一致） */
  workspace(workspaceId: string): WmsWorkspace {
    let ws = this.#cache.get(workspaceId);
    if (!ws) {
      ws = new WmsWorkspace(
        workspaceId,
        this.#core,
        this.#db,
        this.#manifest,
        this.#putawayManifest,
        this.#reversalManifest,
        this.#partialManifest,
        this.#reservationManifest,
        this.#returnManifest,
        this.#asnManifest,
        this.#replenishManifest,
        this.#warehouseManifest,
        this.#zoneManifest,
        this.#serialManifest,
        this.#lpnManifest,
        this.#pickingManifest,
        this.#qcManifest,
        this.#waveManifest,
        this.#packManifest,
        this.#loadManifest,
        this.#reviewManifest,
        this.#reportManifest,
      );
      this.#cache.set(workspaceId, ws);
    }
    return ws;
  }
}

/**
 * WmsWorkspace —— 领域工作区门面：内核五视图 + 领域五投影 + 追账器。
 *
 * 追账模型（「事件是唯一真相，投影是缓存」的直接实现）：
 *  - #cursor 是内存游标（已应用的 lamport 高水位）；
 *  - sync() 增量应用游标之后的 wms.* 事件到五个投影（工具 handler 前后调用）；
 *  - replay() 清空领域投影、游标复位、全量重放——与 sync() 同一条 applyEvent 路径，
 *    迁移/修复/自检是同一个动作（§8.5「全量为真，增量为快」）。
 * 构造期即全量追账一次 + manifest 安装种子：新进程打开旧库（投影落后）、
 * 全新工作区、M4 老库（升级收敛）、M9 老库（M10 结构升级后整组重建）都正确。
 */
export class WmsWorkspace {
  /** 内核五视图（与 WorkspaceFacade 同源，直接展开在门面上） */
  readonly events: EventsView;
  readonly fields: FieldsView;
  readonly tools: ToolsView;
  readonly profile: ProfileView;
  readonly modules: ModulesView;
  /** 声明式实体读写面（B.2/B.3）：与内核门面同一个实例，server 路由直接从这里进 */
  readonly dyn: DynView;

  /** 领域五投影 */
  readonly skus: SkuView;
  readonly locations: LocationView;
  readonly partners: PartnerView;
  readonly orders: OrderView;
  readonly inventory: InventoryView;
  readonly stocktakes: StocktakeView;
  readonly transfers: TransferView;
  readonly scraps: ScrapView;
  readonly pickings: PickingView;
  readonly waves: WaveView;
  readonly warehouses: WarehouseView;
  readonly zones: ZoneView;
  readonly serials: SerialView;
  readonly lpns: LpnView;
  readonly reports: ReportView;
  readonly codes: IntegrationCodeView;

  readonly #facade: WorkspaceFacade;
  readonly #db: Database.Database;
  readonly #projections: WmsProjections;
  readonly #nodeId: string;
  readonly #putawayManifest: ModuleManifest;
  readonly #reversalManifest: ModuleManifest;
  readonly #partialManifest: ModuleManifest;
  readonly #reservationManifest: ModuleManifest;
  readonly #returnManifest: ModuleManifest;
  readonly #asnManifest: ModuleManifest;
  readonly #replenishManifest: ModuleManifest;
  readonly #warehouseManifest: ModuleManifest;
  readonly #zoneManifest: ModuleManifest;
  readonly #serialManifest: ModuleManifest;
  readonly #lpnManifest: ModuleManifest;
  readonly #pickingManifest: ModuleManifest;
  readonly #qcManifest: ModuleManifest;
  readonly #waveManifest: ModuleManifest;
  readonly #packManifest: ModuleManifest;
  readonly #loadManifest: ModuleManifest;
  readonly #reviewManifest: ModuleManifest;
  readonly #reportManifest: ModuleManifest;
  #cursor = -1;

  constructor(
    workspaceId: string,
    core: OneCore,
    db: Database.Database,
    manifest: ModuleManifest,
    putawayManifest: ModuleManifest,
    reversalManifest: ModuleManifest,
    partialManifest: ModuleManifest,
    reservationManifest: ModuleManifest,
    returnManifest: ModuleManifest,
    asnManifest: ModuleManifest,
    replenishManifest: ModuleManifest,
    warehouseManifest: ModuleManifest,
    zoneManifest: ModuleManifest,
    serialManifest: ModuleManifest,
    lpnManifest: ModuleManifest,
    pickingManifest: ModuleManifest,
    qcManifest: ModuleManifest,
    waveManifest: ModuleManifest,
    packManifest: ModuleManifest,
    loadManifest: ModuleManifest,
    reviewManifest: ModuleManifest,
    reportManifest: ModuleManifest,
  ) {
    this.#facade = core.workspace(workspaceId);
    this.#db = db;
    this.#projections = new WmsProjections(db, workspaceId);
    this.#nodeId = core.nodeId;
    this.#putawayManifest = putawayManifest;
    this.#reversalManifest = reversalManifest;
    this.#partialManifest = partialManifest;
    this.#reservationManifest = reservationManifest;
    this.#returnManifest = returnManifest;
    this.#asnManifest = asnManifest;
    this.#replenishManifest = replenishManifest;
    this.#warehouseManifest = warehouseManifest;
    this.#zoneManifest = zoneManifest;
    this.#serialManifest = serialManifest;
    this.#lpnManifest = lpnManifest;
    this.#pickingManifest = pickingManifest;
    this.#qcManifest = qcManifest;
    this.#waveManifest = waveManifest;
    this.#packManifest = packManifest;
    this.#loadManifest = loadManifest;
    this.#reviewManifest = reviewManifest;
    this.#reportManifest = reportManifest;
    this.events = this.#facade.events;
    this.fields = this.#facade.fields;
    this.tools = this.#facade.tools;
    this.profile = this.#facade.profile;
    this.modules = this.#facade.modules;
    this.dyn = this.#facade.dyn;
    this.skus = this.#projections.skus;
    this.locations = this.#projections.locations;
    this.partners = this.#projections.partners;
    this.orders = this.#projections.orders;
    this.inventory = this.#projections.inventory;
    this.stocktakes = this.#projections.stocktakes;
    this.transfers = this.#projections.transfers;
    this.scraps = this.#projections.scraps;
    this.pickings = this.#projections.pickings;
    this.waves = this.#projections.waves;
    this.warehouses = this.#projections.warehouses;
    this.zones = this.#projections.zones;
    this.serials = this.#projections.serials;
    this.lpns = this.#projections.lpns;
    this.reports = this.#projections.reports;
    this.codes = this.#projections.codes;
    // 投影版本戳（层 1）：代码里的派生规则比库里记的新 → 整组重建十张表。
    // 放在 sync() 之前：replay() 自带清空 + 游标复位 + 全量重放，跑完游标已推到
    // 末尾，随后的 sync() 自然是空转——不会重放两遍。
    // 注意 core.workspace() 已在上面构造过，内核投影组（registry/profile）的版本
    // 校验因此先于本组完成，两组各打各的戳。
    ensureProjectionVersion(this.#db, {
      group: WMS_PROJECTION_GROUP.group,
      workspaceId,
      codeVersion: WMS_PROJECTION_GROUP.codeVersion,
      rebuild: () => this.replay(),
    });
    this.sync();
    this.#installBaseModule(manifest);
    this.#installOptional(this.#putawayManifest);
    this.#installOptional(this.#reversalManifest);
    this.#installOptional(this.#partialManifest);
    this.#installOptional(this.#reservationManifest);
    this.#installOptional(this.#returnManifest);
    this.#installOptional(this.#asnManifest);
    this.#installOptional(this.#replenishManifest);
    this.#installOptional(this.#warehouseManifest);
    this.#installOptional(this.#zoneManifest);
    this.#installOptional(this.#serialManifest);
    this.#installOptional(this.#lpnManifest);
    this.#installOptional(this.#pickingManifest);
    this.#installOptional(this.#qcManifest);
    this.#installOptional(this.#waveManifest);
    this.#installOptional(this.#packManifest);
    this.#installOptional(this.#loadManifest);
    this.#installOptional(this.#reviewManifest);
    this.#installOptional(this.#reportManifest);
    this.#alignPickingGate();
    this.#alignPickedState();
    this.#alignPutawayGate();
  }

  /**
   * 老库的入库流程把 received→done 写成了无条件。
   * 打开工作区时给这条边补上「上架未启用才走」。新库种子已经带上，这里是空操作。
   * 补丁对不上时只警告，不挡住打开。
   */
  #alignPutawayGate(): void {
    const inbound = this.profile.getSnapshot().workflows.inbound;
    if (!inbound) return;
    const patch = inboundPutawayPatch(inbound);
    if (!patch) return;
    const actor = `module:module.putaway@${this.#nodeId}`;
    let proposalId: string | undefined;
    try {
      proposalId = this.profile.propose(actor, patch, '入库上架步骤改为必做').proposalId;
      this.profile.confirm(proposalId, actor);
    } catch (e) {
      if (proposalId) {
        try {
          this.profile.reject(proposalId);
        } catch {
          // 提议已经不在待确认里
        }
      }
      console.warn(
        `[module.putaway] 入库流程未能补上上架开关：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 老库的出库流程在种子里写死了 created→picking，base 装过就不再改。
   * 打开工作区时把缺的 when 和绕行边补上。新库种子已经带上，这里是空操作。
   * 补丁对不上时只警告，不挡住打开。
   */
  #alignPickingGate(): void {
    const outbound = this.profile.getSnapshot().workflows.outbound;
    if (!outbound) return;
    const patch = outboundPickingPatch(outbound);
    if (!patch) return;
    const actor = `module:module.picking@${this.#nodeId}`;
    let proposalId: string | undefined;
    try {
      proposalId = this.profile.propose(actor, patch, '出库拣货步骤改为可开关').proposalId;
      this.profile.confirm(proposalId, actor);
    } catch (e) {
      if (proposalId) {
        try {
          this.profile.reject(proposalId);
        } catch {
          // 提议已经不在待确认里
        }
      }
      console.warn(
        `[module.picking] 出库流程未能补上拣货开关：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** 老库补「已拣货」。新库安装时已经贡献过，这里是空操作。 */
  #alignPickedState(): void {
    const outbound = this.profile.getSnapshot().workflows.outbound;
    if (!outbound) return;
    const patch = outboundPickedPatch(outbound);
    if (!patch) return;
    const actor = `module:module.picking@${this.#nodeId}`;
    let proposalId: string | undefined;
    try {
      proposalId = this.profile.propose(actor, patch, '出库增加已拣货').proposalId;
      this.profile.confirm(proposalId, actor);
    } catch (e) {
      if (proposalId) {
        try {
          this.profile.reject(proposalId);
        } catch {
          // 提议已经不在待确认里
        }
      }
      console.warn(
        `[module.picking] 出库流程未能补上已拣货：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 模块化种子（M6，替代 M4 手写 #seedDefaultProfile）：manifest 驱动的受管安装。
   *  - 新库：字段 provide（owner='core.wms'）+ base 流程（从转移表誊写）+ modules 段登记；
   *  - 老库（M4 手写种子过的库）：字段 DO NOTHING + usedBy 追加（owner 保持 'core'，
   *    归属语义自洽）、base 守卫跳过、仅登记 modules 段——一次性收敛；
   *  - 已装库（重开文件库）：install 幂等短路（同版本已装，零新事件）。
   * core 不认识仓储词汇，manifest 内容必须由领域声明（领域隔离铁律）。
   * 种子事件的 actor 带 @nodeId 后缀：每个节点各自落自己的种子（eventId 不同），
   * 同步交换时 (actor, seq) 不撞账本唯一约束（M5 同步决策 5）。
   */
  #installBaseModule(manifest: ModuleManifest): void {
    this.modules.install(manifest, { actor: `module:${manifest.id}@${this.#nodeId}` });
  }

  /**
   * 可选业务模块：默认安装并启用。流程已被改到对不上贡献时降级跳过，
   * 不阻塞打开工作区。停用走设置页慢通道。
   */
  #installOptional(manifest: ModuleManifest): void {
    try {
      this.modules.install(manifest, { actor: `module:${manifest.id}@${this.#nodeId}` });
    } catch (e) {
      console.warn(
        `[${manifest.id}] 安装降级（流程贡献校验未过，该模块不可用）：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * 增量追账：把游标之后本工作区的 wms.* 事件应用到领域投影。
   * 单事务；applyEvent 抛错（状态冲突）则整体回滚、游标不动——确定性失败。
   */
  sync(): { appliedEvents: number } {
    const run = this.#db.transaction(() => {
      const { appliedWmsEvents } = this.#consumeEvents();
      return { appliedEvents: appliedWmsEvents };
    });
    return run();
  }

  /** 游标之后的事件消费路径：增量追账与清库后的全量重放共用。 */
  #consumeEvents(): { totalEvents: number; appliedWmsEvents: number } {
    let totalEvents = 0;
    let appliedWmsEvents = 0;
    this.events.forEach((env) => {
      totalEvents++;
      if (isWmsEventType(env.type)) {
        this.#projections.applyEvent(env);
        appliedWmsEvents++;
      }
      this.#cursor = env.lamport;
    }, { fromLamport: this.#cursor });
    return { totalEvents, appliedWmsEvents };
  }

  /**
   * 全量重放重建领域投影（不含内核投影——那是 core.replay() 的职责）。
   * 幂等；「事件账本 ↔ 领域投影」强一致的自检路径。
   */
  replay(): { totalEvents: number; appliedWmsEvents: number } {
    const run = this.#db.transaction(() => {
      this.#projections.clear();
      this.#cursor = -1;
      return this.#consumeEvents();
    });
    return run();
  }

  /**
   * 全量重放「内核 + 领域」两层投影（M5 同步回合后的重建入口）。
   * 先内核（注册表 / Profile）后领域（SKU / 单据 / 库存）——各自独立事务，顺序固定。
   * 摄入远端事件后调用一次：账本增量交换、投影全量重建的最保守实现。
   */
  replayAll(): { core: ReturnType<WorkspaceFacade['replay']>; wms: ReturnType<WmsWorkspace['replay']> } {
    return { core: this.#facade.replay(), wms: this.replay() };
  }

  /**
   * 多事件原子落账（M9 单据→库存联动）：把若干 ctx.appendEvent 包进一个事务，
   * 同生共死——任一 append 失败整体回滚，杜绝「状态变了库存没动」的半落账。
   * better-sqlite3 嵌套事务自动降级为 savepoint，OplogStore.append 的独立事务
   * 在本包裹内安全嵌套。仅供工具 handler 的发射段调用（校验在包裹外完成——
   * 命令失败 ≠ 事实，拒绝路径不进事务）。
   */
  runAtomic<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }
}
