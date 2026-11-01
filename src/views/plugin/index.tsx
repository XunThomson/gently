import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {CoreResult} from '../../api';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {BadgeCell, DataTable, TextCell, type ColumnDef} from '../../components/ui/data-table';
import {IconPuzzle} from '../../components/ui/icon';
import {actionsColumn, indexColumn} from '../../config/table.config';
import {useConfirm} from '../../hooks/useConfirm';
import {errorText} from '../../i18n/errors';
import {corePlugin, libraryService} from '../../services';
import {useActions, usePluginState, useSelect} from '../../store';
import type {PluginInfo} from '../../types';
import {ImportPanel} from './components/import-panel';
import {PluginManage} from './components/plugin-manage';
import {SubscriptionPanel} from './components/subscription-panel';
import styles from './plugin.module.css';

type Drawer = 'import' | 'subscription' | null;

/**
 * 插件页。
 *
 * 三块，各自只有一个职责（R87 重排）：
 * 1. **已安装插件**（表格）——页面主体，行内只有 4 个高频动作（启停 / 管理 / 检查更新 / 卸载）；
 * 2. **管理面板**——点「管理」后固定在表格上方，放回退顺序、重载、权限收敛与凭据/配置；
 * 3. **抽屉**——导入与订阅两个表单默认收起，工具条按钮打开（以前两块常驻表单把表格压到很下面）。
 *
 * 数据只有一份：`plugin.list`（store）。以前导入面板自己 `plugin.list` 了一份，
 * 于是「装完只在导入面板里出现、表格还是旧的」——那也是「要重启才生效」的一半原因。
 */
export default function PluginView() {
    const {t} = useTranslation();
    const {list, loaded} = usePluginState();
    const {load, reload, setEnabled, remove, update} = useActions().plugin;
    const confirm = useConfirm();

    const [drawer, setDrawer] = useState<Drawer>(null);
    /** 正在管理（凭据 / 配置 / 优先级）的插件 id */
    const [manageId, setManageId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [manageError, setManageError] = useState<string | null>(null);
    /** 当前曲目实际在用的音源：管理面板里给一个「正在使用」的标记 */
    const activeSource = useSelect((s) => s.player.activeSource);

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(
        () => [...list].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)),
        [list],
    );

    const managed = manageId ? rows.find((plugin) => plugin.id === manageId) ?? null : null;

    /** 统一动作包装：失败只提示；成功后重读清单（含按源路由缓存） */
    const run = async (action: () => Promise<CoreResult<unknown>>) => {
        setBusy(true);
        setManageError(null);
        const result = await action();
        setBusy(false);
        if (!result.ok) {
            setManageError(errorText(t, result.error));
            return false;
        }
        await reload();
        return true;
    };

    /** 上/下移：整表重排后按 10 递增回写优先级（默认优先级都相同，交换数值无效，必须重排） */
    const move = async (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= rows.length) return;
        const next = [...rows];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);

        setBusy(true);
        setManageError(null);
        for (const [position, plugin] of next.entries()) {
            const want = (position + 1) * 10;
            if (plugin.priority === want) continue;
            /* 走 `libraryService`（而不是直接 `corePlugin`）：内置演示源不在核心里，
               服务层会跳过它——直接发过去只会换回一条 `common.not_found` 并弹错 */
            const result = await libraryService.setPluginPriority(plugin.id, want);
            if (!result.ok) {
                setManageError(errorText(t, result.error));
                break;
            }
        }
        setBusy(false);
        await reload();
    };

    /**
     * 兼容模式收敛（ADR-0006/TOFU）：先把观测到的域名摆给用户看，确认后固化成白名单。
     *
     * 这是**收窄**动作（之后该插件只能访问这些域名），因此走二次确认；
     * 没有观测记录时明确提示「先使用一次」，而不是弹一个空列表。
     */
    const converge = async (plugin: PluginInfo) => {
        setBusy(true);
        setManageError(null);
        const result = await corePlugin.observedHosts(plugin.id);
        setBusy(false);
        if (!result.ok) {
            setManageError(errorText(t, result.error));
            return;
        }
        const hosts = result.data.hosts.map((entry) => entry.host);
        if (hosts.length === 0) {
            setManageError(t('page.plugin.compatNoHosts'));
            return;
        }
        confirm({
            titleKey: 'confirm.compatTitle',
            descKey: 'confirm.compatDesc',
            descParams: {name: plugin.name, hosts: hosts.join(' / ')},
            tone: 'danger',
            onConfirm: () => void run(() => corePlugin.confirmHosts(plugin.id, hosts)),
        });
    };

    const columns: ColumnDef<PluginInfo>[] = [
        indexColumn<PluginInfo>(),
        {
            key: 'name',
            title: t('column.title'),
            width: 'minmax(180px, 1.4fr)',
            render: (value, record) => (
                <span className={styles.nameCell}>
                    <TextCell>{String(value)}</TextCell>
                    <BadgeCell tone={record.builtin ? 'accent' : 'muted'}>
                        {record.builtin ? t('page.plugin.builtinTag') : t('page.plugin.thirdPartyTag')}
                    </BadgeCell>
                    {/* 兼容插件不能与自有 ABI 插件看起来同等安全 */}
                    {record.compat && (
                        <BadgeCell tone="warning">{t('page.plugin.compatBadge')}</BadgeCell>
                    )}
                    {activeSource === record.id && (
                        <BadgeCell tone="success">{t('page.plugin.inUse')}</BadgeCell>
                    )}
                    {record.description && (
                        <span className={styles.nameDesc}>{record.description}</span>
                    )}
                </span>
            ),
        },
        {
            key: 'version',
            title: t('column.version'),
            width: '88px',
            align: 'center',
            render: (value, record) => (
                <TextCell tone="muted">
                    v{String(value)}
                    {record.author ? ` · ${record.author}` : ''}
                </TextCell>
            ),
        },
        {
            key: 'enabled',
            title: t('column.status'),
            width: '84px',
            align: 'center',
            render: (value) =>
                value ? (
                    <BadgeCell tone="success">{t('common.enabled')}</BadgeCell>
                ) : (
                    <BadgeCell tone="muted">{t('common.disabled')}</BadgeCell>
                ),
        },
        actionsColumn<PluginInfo>(t, (plugin) => [
            {
                key: 'toggle',
                label: plugin.enabled ? t('common.disable') : t('common.enable'),
                tone: plugin.enabled ? 'default' : 'primary',
                onClick: () => {
                    setEnabled(plugin.id, !plugin.enabled);
                    void reload();
                },
            },
            {
                key: 'manage',
                label: manageId === plugin.id ? t('page.plugin.settingsClose') : t('page.plugin.manage'),
                onClick: () => {
                    setManageError(null);
                    setManageId(manageId === plugin.id ? null : plugin.id);
                },
            },
            {
                key: 'update',
                label: t('common.update'),
                onClick: () => {
                    void update(plugin.id);
                    // 更新只改版本号 / 来源比对结果，不重读清单（轻量、不产生额外 IPC 风暴）
                },
            },
            {
                key: 'remove',
                label: t('common.uninstall'),
                tone: 'danger',
                // 内置源不可卸载（浏览器预览里的演示源就是这种）
                disabled: plugin.builtin,
                onClick: () =>
                    confirm({
                        titleKey: 'confirm.uninstallPluginTitle',
                        descKey: 'confirm.uninstallPluginDesc',
                        descParams: {name: plugin.name},
                        tone: 'danger',
                        onConfirm: () => remove(plugin.id),
                    }),
            },
        ]),
    ];

    return (
        <Page
            title={t('page.plugin.title')}
            subtitle={t('page.plugin.subtitle', {count: list.length})}
            toolbar={
                <>
                    <Button
                        size="sm"
                        variant={drawer === 'import' ? 'primary' : 'ghost'}
                        icon={<IconPuzzle size={14}/>}
                        onClick={() => setDrawer((prev) => (prev === 'import' ? null : 'import'))}
                    >
                        {t('page.plugin.openImport')}
                    </Button>
                    <Button
                        size="sm"
                        variant={drawer === 'subscription' ? 'primary' : 'ghost'}
                        onClick={() =>
                            setDrawer((prev) => (prev === 'subscription' ? null : 'subscription'))
                        }
                    >
                        {t('page.plugin.subscriptionTitle')}
                    </Button>
                </>
            }
        >
            {/* 抽屉：一次只开一个，收起时不占版面 */}
            {drawer === 'import' && <ImportPanel/>}
            {drawer === 'subscription' && <SubscriptionPanel/>}

            {/* 管理面板固定在表格上方：用户始终知道自己在配置哪个插件 */}
            {managed && (
                <PluginManage
                    plugin={managed}
                    index={rows.findIndex((plugin) => plugin.id === managed.id)}
                    total={rows.length}
                    busy={busy}
                    error={manageError}
                    onClose={() => setManageId(null)}
                    onMove={(index, delta) => void move(index, delta)}
                    onReload={() => void run(() => corePlugin.reload(managed.id))}
                    onConverge={() => void converge(managed)}
                />
            )}

            <DataTable
                columns={columns}
                dataSource={rows}
                rowKey="id"
                loading={!loaded}
                loadingText={t('common.loading')}
                emptyText={loaded ? t('page.plugin.installedEmpty') : t('common.loading')}
            />
        </Page>
    );
}
