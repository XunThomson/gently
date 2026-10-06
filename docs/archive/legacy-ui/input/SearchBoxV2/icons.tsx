/* ==================== icons.tsx ==================== */
import React from 'react';
import type { IconProps } from './types';

const base: IconProps = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
};

export const SearchIcon: React.FC<IconProps> = ({ size = 18, ...rest }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} strokeWidth={2} {...base} {...rest}>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.6-3.6" />
    </svg>
);

export const CloseIcon: React.FC<IconProps> = ({ size = 14, ...rest }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} strokeWidth={2} {...base} {...rest}>
        <path d="M6 6l12 12M18 6L6 18" />
    </svg>
);

export const ClockIcon: React.FC<IconProps> = ({ size = 15, ...rest }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} strokeWidth={1.8} {...base} {...rest}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
    </svg>
);