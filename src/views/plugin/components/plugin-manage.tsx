import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {BadgeCell, TextCell} from '../../../components/ui/data-table';
import type {PluginInfo} from '../../../types';
import styles from '../plugin.module.css';
import {PluginSettings} from './plugin-settings';

export interface PluginManageProps {
    plugin: PluginInfo;
    /** 在已排序清单里的位置（决定「上移 / 下移」是否可用） */
    index: number;
    total: number;
    busy: boolean;
    onClose: () => void;
    onMove: (index: number, delta: number) => void;
    onReload: () => void;
    onConverge: () => void;
    /** 错误信息（优先级写入 / 重载失败都要能看见原因） */
    error: string | null;
}

/**
 * 单个插件的**管理面板**（页面里唯一「聚焦」的那块）。
 *
 * 为什么把管理动作从表格行里搬出来：导入面板曾经自带一份「已导入的插件」清单，
 * 每行挂了 7 个按钮（上移 / 下移 / 启停 / 重载 / 凭据 / 收敛 / 卸载），而下面表格里
 * 又有同一批插件的另一份清单——**同一批数据出现两次**，按钮密度也高到无法聚焦。
 * 现在：表格只留 4 个高频动作，低频/需要上下文的动作（回退顺序、重载、权限收敛、
 * 凭据配置）全部收进这块面板，面板标题始终显示「在管哪个插件」。
 */
export function PluginManage({
    plugin,
    index,
    total,
    busy,
    onClose,
    onMove,
    onReload,
    onConverge,
    error,
}: PluginManageProps) {
    const {t} = useTranslation();

    return (
        <section className={styles.manage}>
            <header className={styles.manageHead}>
                <span className={styles.manageTitle}>
                    {t('page.plugin.manageTitle', {name: plugin.name})}
                    <TextCell tone="muted"> v{plugin.version}</TextCell>
                    {plugin.compat && <BadgeCell tone="warning">{t('page.plugin.compatBadge')}</BadgeCell>}
                    {plugin.builtin && <BadgeCell tone="accent">{t('page.plugin.builtinTag')}</BadgeCell>}
                </span>
                <Button size="sm" variant="ghost" onClick={onClose}>
                    {t('page.plugin.settingsClose')}
                </Button>
            </header>

            {plugin.description && <TextCell tone="muted">{plugin.description}</TextCell>}

            <div className={styles.manageRow}>
                {/* 回退顺序：数值越小越优先，因此用「上移 / 下移」表达（数值本身对用户没有意义） */}
                <span className={styles.label}>{t('page.plugin.priorityLabel')}</span>
                <span className={styles.actions}>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || index <= 0}
                        onClick={() => onMove(index, -1)}
                    >
                        {t('page.plugin.moveUp')}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || index < 0 || index >= total - 1}
                        onClick={() => onMove(index, 1)}
                    >
                        {t('page.plugin.moveDown')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={onReload}>
                        {t('page.plugin.reload')}
                    </Button>
                    {plugin.compat && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={onConverge}>
                            {t('page.plugin.compatConverge')}
                        </Button>
                    )}
                </span>
            </div>
            <p className={styles.hint}>{t('page.plugin.priorityHint')}</p>

            {error && <TextCell tone="danger">{error}</TextCell>}

            {/* 凭据 / 配置 / 第三方授权 / 登录：这些都需要「选中某个插件」的上下文 */}
            <PluginSettings plugin={plugin}/>
        </section>
    );
}

export default PluginManage;
