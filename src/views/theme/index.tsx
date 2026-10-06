import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {themePresets, useTheme} from '../../theme';
import type {ThemePreset} from '../../theme';
import styles from './theme.module.css';

/**
 * 主题市场：列出 presets.json 中的全部预设，点击「应用」立即生效。
 * 唯一的写入路径是 `setPreset`（store 的 ui 切片），本视图不保留副本状态。
 */
export default function ThemeView() {
    const {t} = useTranslation();
    const {presetId, setPreset} = useTheme();

    return (
        <Page title={t('page.theme.title')} subtitle={t('page.theme.subtitle')}>
            <div className={styles.grid}>
                {themePresets.map((preset: ThemePreset) => {
                    const active = preset.id === presetId;

                    return (
                        <div
                            key={preset.id}
                            className={[styles.card, active ? styles.cardActive : '']
                                .filter(Boolean)
                                .join(' ')}
                        >
                            <div className={styles.preview}>
                                {preset.swatches.map((color) => (
                                    <span
                                        key={color}
                                        className={styles.swatch}
                                        style={{background: color}}
                                    />
                                ))}
                            </div>

                            <span className={styles.name}>{preset.name}</span>
                            <span className={styles.description}>{preset.description}</span>
                            <span className={styles.author}>
                                {t('page.theme.by', {name: preset.author})}
                            </span>

                            <Button
                                className={styles.apply}
                                size="sm"
                                variant={active ? 'default' : 'primary'}
                                disabled={active}
                                onClick={() => setPreset(preset.id)}
                            >
                                {t(active ? 'page.theme.applied' : 'page.theme.apply')}
                            </Button>
                        </div>
                    );
                })}
            </div>
        </Page>
    );
}
