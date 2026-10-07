import type {JSX} from 'react';
import {useTranslation} from 'react-i18next';
import type {RecommendationReason} from '../../../types';
import styles from './ReasonChip.module.css';

export interface ReasonChipProps {
    reason: RecommendationReason;
    className?: string;
}

/**
 * 「为什么推荐」小胶囊：把 `reason.kind` 映射成一句可读文案。
 * 四种理由共用同一套 i18n key，文案缺失时只在 key 层补齐，不改组件。
 */
export function ReasonChip({reason, className}: ReasonChipProps): JSX.Element {
    const {t} = useTranslation();

    const label = (): string => {
        switch (reason.kind) {
            case 'artist':
                return t('recommend.reasonArtist', {name: reason.value});
            case 'tag':
                return t('recommend.reasonTag', {name: reason.value});
            case 'similar':
                return t('recommend.reasonSimilar', {name: reason.value});
            case 'trending':
                return t('recommend.reasonTrending');
        }
    };

    return (
        <span className={[styles.chip, className].filter(Boolean).join(' ')}>{label()}</span>
    );
}

export default ReasonChip;
