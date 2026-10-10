import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {BadgeCell, DataTable, TextCell, type ColumnDef} from '../../components/ui/data-table';
import {actionsColumn, indexColumn} from '../../config/table.config';
import {useConfirm} from '../../hooks/useConfirm';
import {useActions, usePluginState} from '../../store';
import type {PluginInfo} from '../../types';
import {ImportPanel} from './components/import-panel';

export default function PluginView() {
    const {t} = useTranslation();
    const {list, loaded} = usePluginState();
    const {load, setEnabled, remove, update} = useActions().plugin;
    const confirm = useConfirm();

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo(
        () => [...list].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)),
        [list],
    );

    const columns: ColumnDef<PluginInfo>[] = [
        indexColumn<PluginInfo>(),
        {
            key: 'name',
            title: t('column.title'),
            width: 'minmax(180px, 1.2fr)',
            render: (value, record) => (
                <span>
                    <TextCell>{String(value)}</TextCell>{' '}
                    <BadgeCell tone={record.builtin ? 'accent' : 'muted'}>
                        {record.builtin ? t('page.plugin.builtinTag') : t('page.plugin.thirdPartyTag')}
                    </BadgeCell>
                </span>
            ),
        },
        {
            key: 'version',
            title: t('column.version'),
            width: '96px',
            align: 'center',
            render: (value) => <TextCell tone="muted">v{String(value)}</TextCell>,
        },
        {
            key: 'author',
            title: t('column.author'),
            width: 'minmax(100px, 1fr)',
            render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
        },
        {
            key: 'description',
            title: t('column.description'),
            width: 'minmax(200px, 1.6fr)',
            render: (value) => <TextCell tone="muted">{String(value)}</TextCell>,
        },
        {
            key: 'enabled',
            title: t('column.status'),
            width: '92px',
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
                onClick: () => setEnabled(plugin.id, !plugin.enabled),
            },
            {
                key: 'update',
                label: t('common.update'),
                onClick: () => update(plugin.id),
            },
            {
                key: 'remove',
                label: t('common.uninstall'),
                tone: 'danger',
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
        >
            {/* 本机核心插件：用户自行导入（不预置任何来源，ADR-0005） */}
            <ImportPanel/>

            <DataTable
                columns={columns}
                dataSource={rows}
                rowKey="id"
                loading={!loaded}
                loadingText={t('common.loading')}
                emptyText={loaded ? t('page.plugin.empty') : t('common.loading')}
            />
        </Page>
    );
}
