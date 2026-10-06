import type { ModifierDef, ModifierValue, ViewNode } from '../types';

export const MODIFIERS: Record<string, ModifierDef> = {
    /* -------- 外观 -------- */
    opacity: {
        group: '外观', label: '透明度', type: 'number',
        min: 0, max: 1, step: 0.05, default: 1,
        apply: (s, v) => { s.opacity = v as number; },
    },
    background: {
        group: '外观', label: '背景色', type: 'color', default: '',
        apply: (s, v) => { if (v) s.background = v as string; },
    },
    borderRadius: {
        group: '外观', label: '圆角', type: 'number',
        min: 0, max: 44, step: 1, default: 16,
        apply: (s, v) => { s.borderRadius = v as number; },
    },
    borderWidth: {
        group: '外观', label: '边框', type: 'number',
        min: 0, max: 6, step: 1, default: 0,
        apply: (s, v) => {
            const n = v as number;
            s.borderWidth = n;
            s.borderStyle = n > 0 ? 'solid' : 'none';
        },
    },
    borderColor: {
        group: '外观', label: '边框色', type: 'color', default: '#4da3ff',
        apply: (s, v) => { s.borderColor = v as string; },
    },
    shadow: {
        group: '外观', label: '阴影', type: 'select', default: 'none',
        options: [
            { value: 'none', label: '无' },
            { value: 'sm', label: '小' },
            { value: 'md', label: '中' },
            { value: 'lg', label: '大' },
            { value: 'glow', label: '发光' },
        ],
        apply: (s, v) => {
            const map: Record<string, string> = {
                none: 'none',
                sm: '0 2px 6px rgba(0,0,0,.25)',
                md: '0 6px 18px rgba(0,0,0,.35)',
                lg: '0 14px 36px rgba(0,0,0,.5)',
                glow: '0 0 0 3px rgba(77,163,255,.35), 0 8px 26px rgba(77,163,255,.45)',
            };
            s.boxShadow = map[v as string] ?? 'none';
        },
    },
    glass: {
        group: '外观', label: '毛玻璃', type: 'boolean', default: false,
        apply: (s, v) => {
            if (v) {
                s.backdropFilter = 'blur(14px) saturate(1.6)';
                s.WebkitBackdropFilter = 'blur(14px) saturate(1.6)';
            }
        },
    },

    /* -------- 变换 -------- */
    rotate: {
        group: '变换', label: '旋转', type: 'number',
        min: -180, max: 180, step: 1, default: 0,
        apply: (_s, v, _n, h) => { if (v) h.addTransform(`rotate(${v as number}deg)`); },
    },
    scale: {
        group: '变换', label: '缩放', type: 'number',
        min: 0.5, max: 1.6, step: 0.02, default: 1,
        apply: (_s, v, _n, h) => { if (v !== 1) h.addTransform(`scale(${v as number})`); },
    },

    /* -------- 布局 -------- */
    visible: {
        group: '布局', label: '可见', type: 'boolean', default: true,
        apply: (s, v) => { if (!v) s.visibility = 'hidden'; },
    },
    zIndex: {
        group: '布局', label: '层级', type: 'number',
        min: 0, max: 60, step: 1, default: 1,
        apply: (s, v) => { s.zIndex = v as number; },
    },
    padding: {
        group: '布局', label: '内边距', type: 'number',
        min: 0, max: 24, step: 1, default: 0,
        apply: (s, v) => { s.padding = v as number; },
    },

    /* -------- 交互 -------- */
    disabled: {
        group: '交互', label: '禁用', type: 'boolean', default: false,
        apply: (s, v, _n, h) => {
            if (!v) return;
            s.filter = 'grayscale(.75)';
            s.opacity = (Number(s.opacity ?? 1)) * 0.55;
            if (h.mode === 'view') s.pointerEvents = 'none';
        },
    },
};

export const MODIFIER_GROUPS: Record<string, [string, ModifierDef][]> = (() => {
    const g: Record<string, [string, ModifierDef][]> = {};
    for (const [key, def] of Object.entries(MODIFIERS)) {
        (g[def.group] ||= []).push([key, def]);
    }
    return g;
})();

export function getModifierValue(node: ViewNode, key: string): ModifierValue | undefined {
    const md = MODIFIERS[key];
    if (!md) return undefined;
    return node.modifiers?.[key] ?? md.default;
}