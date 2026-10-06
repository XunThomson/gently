// DataTable.tsx
import React from 'react';
import styles from './DataTable.module.css';

export interface ColumnDef<T> {
    key: string;
    title: string;
    width?: string; // 支持 '50px' / '1fr' / 'minmax(250px, 1.5fr)'
    align?: 'left' | 'center' | 'right';
    render?: (value: any, record: T, index: number) => React.ReactNode;
}

interface DataTableProps<T> {
    columns: ColumnDef<T>[];
    dataSource: T[];
    rowKey: keyof T | ((record: T) => string | number);
    onRowClick?: (record: T) => void;
}

export function DataTable<T extends Record<string, any>>({
                                                             columns,
                                                             dataSource,
                                                             rowKey,
                                                             onRowClick,
                                                         }: DataTableProps<T>) {
    const getRowKey = (record: T, index: number) => {
        if (typeof rowKey === 'function') return rowKey(record);
        return String(record[rowKey] ?? index);
    };

    // 把每一列的 width 拼成 grid-template-columns
    const gridTemplate = columns.map((col) => col.width || 'minmax(0, 1fr)').join(' ');

    return (
        <div className={styles.container}>
            <div
                className={styles.table}
                style={{ '--grid-template': gridTemplate } as React.CSSProperties}
            >
                {/* 表头 */}
                <div className={styles.headerRow}>
                    {columns.map((col) => (
                        <div
                            key={col.key}
                            className={`${styles.headerCell} ${styles[col.align || 'left']}`}
                        >
                            {col.title}
                        </div>
                    ))}
                </div>

                {/* 数据体 / 空态 */}
                {dataSource.length === 0 ? (
                    <div className={styles.emptyRow}>暂无数据</div>
                ) : (
                    dataSource.map((record, rowIndex) => (
                        <div
                            key={getRowKey(record, rowIndex)}
                            className={styles.row}
                            onClick={() => onRowClick?.(record)}
                        >
                            {columns.map((col) => {
                                const value = record[col.key];
                                return (
                                    <div
                                        key={col.key}
                                        className={`${styles.bodyCell} ${styles[col.align || 'left']}`}
                                    >
                                        {col.render ? col.render(value, record, rowIndex) : value}
                                    </div>
                                );
                            })}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}