import React from 'react';
import {useShellMode} from '../../../hooks/useShellMode';
import type {ShellMode} from '../../../utils/shellMode';
import styles from './DataTable.module.css';

export interface ColumnDef<T> {
    key: string;
    title: string;
    /** 支持 '50px' / '1fr' / 'minmax(250px, 1.5fr)' */
    width?: string;
    align?: 'left' | 'center' | 'right';
    render?: (value: unknown, record: T, index: number) => React.ReactNode;
}

/**
 * 表格实际用哪一份列定义。
 *
 * 手机形态**且**调用方给了手机列 → 用手机列；其余一律用桌面列。
 * 抽成纯函数是为了让冒烟能直接钉住「手机换列、桌面不换」这条裁决，
 * 而不是靠渲染一整页去凑（渲染环境里拿不到真实的手机形态）。
 */
export function resolveColumns<T>(
    shell: ShellMode,
    columns: ColumnDef<T>[],
    mobileColumns?: ColumnDef<T>[],
): ColumnDef<T>[] {
    return shell === 'mobile' && mobileColumns ? mobileColumns : columns;
}

export interface DataTableProps<T> {
    columns: ColumnDef<T>[];
    /**
     * 手机上的列定义（两行式，见 `config/table.config.tsx`）。
     *
     * 传了就用它——**由外壳形态决定，视图里不写 `@media`**：
     * 桌面 7 列在 360px 宽下会被裁掉（P1-5 真机复现），所以手机换一份而不是压窄。
     */
    mobileColumns?: ColumnDef<T>[];
    dataSource: T[];
    rowKey: keyof T | ((record: T) => string | number);
    onRowClick?: (record: T) => void;
    /** 骨架 / 加载态文案，缺省不显示加载行 */
    loadingText?: string;
    emptyText?: string;
    loading?: boolean;
    /** 当前高亮的行（如正在播放） */
    activeRowKey?: string | number;
}

/**
 * 通用数据表格：纯展示组件。
 * 列定义、数据与文案全部由调用方注入（配置驱动 + i18n），组件本身不含业务数据。
 */
export function DataTable<T>({
    columns,
    mobileColumns,
    dataSource,
    rowKey,
    onRowClick,
    loading = false,
    loadingText,
    emptyText,
    activeRowKey,
}: DataTableProps<T>) {
    const shell = useShellMode();
    const mobile = shell === 'mobile' && !!mobileColumns;
    const activeColumns = resolveColumns(shell, columns, mobileColumns);

    const getRowKey = (record: T, index: number): string | number => {
        if (typeof rowKey === 'function') return rowKey(record);
        const value = (record as Record<string, unknown>)[rowKey as string];
        return typeof value === 'string' || typeof value === 'number' ? value : index;
    };

    const gridTemplate = activeColumns.map((col) => col.width ?? 'minmax(0, 1fr)').join(' ');

    return (
        <div className={styles.container}>
            <div
                className={styles.table}
                data-layout={mobile ? 'mobile' : 'desktop'}
                style={{'--grid-template': gridTemplate} as React.CSSProperties}
            >
                <div className={styles.headerRow}>
                    {activeColumns.map((col) => (
                        <div
                            key={col.key}
                            className={`${styles.headerCell} ${styles[col.align ?? 'left']}`}
                        >
                            {col.title}
                        </div>
                    ))}
                </div>

                {loading && loadingText ? (
                    <div className={styles.stateRow}>{loadingText}</div>
                ) : dataSource.length === 0 ? (
                    <div className={styles.stateRow}>{emptyText}</div>
                ) : (
                    dataSource.map((record, rowIndex) => {
                        const key = getRowKey(record, rowIndex);
                        const active = activeRowKey !== undefined && String(activeRowKey) === String(key);

                        return (
                            <div
                                key={key}
                                className={`${styles.row}${active ? ` ${styles.active}` : ''}`}
                                onClick={() => onRowClick?.(record)}
                            >
                                {activeColumns.map((col) => (
                                    <div
                                        key={col.key}
                                        className={`${styles.bodyCell} ${styles[col.align ?? 'left']}`}
                                    >
                                        {col.render
                                            ? col.render((record as Record<string, unknown>)[col.key], record, rowIndex)
                                            : ((record as Record<string, unknown>)[col.key] as React.ReactNode)}
                                    </div>
                                ))}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
