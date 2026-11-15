import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {petService, windowService} from '../../services';
import type {PetStateDto} from '../../services';
import {PET_SIZE_MAX, PET_SIZE_MIN} from '../../utils/petPresentation';
import styles from './pet-panel.module.css';

/**
 * 宠物控制面板（独立 Tauri 窗口，R145）。
 *
 * 与宠物本体窗分离：面板自己是一个普通置顶小窗，可以聚焦、滚动、关闭，
 * 不再塞在宠物窗口的透明 HUD 预留里（那会挡住主窗口，也会和气泡抢位置）。
 * 数据全部走 pet-core 的 `pet.state / pet.interact`；尺寸/游走走窗口服务。
 */
export function PetPanelApp() {
    const {t} = useTranslation();
    const [state, setState] = useState<PetStateDto | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [size, setSize] = useState(() => windowService.petSize());
    const [roam, setRoam] = useState(() => windowService.petRoam());

    const refresh = async () => {
        const result = await petService.state();
        if (result.ok && result.data) {
            setState(result.data);
            setError('');
        } else if (result.error) {
            setError(result.error.message);
        }
    };

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), 1200);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') void windowService.hidePetPanel();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    const current = state?.pets.find((pet) => pet.active) ?? state?.pets[0] ?? null;

    const interact = async (kind: 'feed' | 'touch') => {
        if (!current || busy) return;
        setBusy(true);
        const result = await petService.interact(current.id, kind);
        setBusy(false);
        if (!result.ok && result.error) setError(result.error.message);
        await refresh();
    };

    const hidePet = async () => {
        await windowService.hidePetWindow();
        windowService.notifyPetWindowClosed();
        await windowService.hidePetPanel();
    };

    return (
        <div className={styles.root}>
            <header className={styles.head}>
                <div>
                    <h1 className={styles.title}>{t('pet.panel.title')}</h1>
                    <p className={styles.meta}>
                        {current
                            ? `${current.name} · ${t(`pet.mood.${current.mood}`)} · ${t('pet.status.level', {level: current.growth.level})}`
                            : '—'}
                    </p>
                </div>
                <button
                    type="button"
                    className={styles.close}
                    aria-label={t('common.close')}
                    title={t('common.close')}
                    onClick={() => void windowService.hidePetPanel()}
                >
                    ✕
                </button>
            </header>

            {error && <p className={styles.error}>{error}</p>}

            <section className={styles.section}>
                <h2 className={styles.sectionTitle}>{t('pet.panel.quick')}</h2>
                <div className={styles.actions}>
                    <button
                        type="button"
                        className={styles.action}
                        disabled={!current || busy}
                        onClick={() => void interact('feed')}
                    >
                        {t('pet.action.feed')}
                    </button>
                    <button
                        type="button"
                        className={styles.action}
                        disabled={!current || busy}
                        onClick={() => void interact('touch')}
                    >
                        {t('pet.action.touch')}
                    </button>
                </div>
            </section>

            <section className={styles.section}>
                <h2 className={styles.sectionTitle}>{t('pet.panel.appearance')}</h2>
                <div className={styles.sizeRow}>
                    <span>{t('pet.action.size')}</span>
                    <span className={styles.value}>{size} px</span>
                </div>
                <input
                    className={styles.range}
                    type="range"
                    min={PET_SIZE_MIN}
                    max={PET_SIZE_MAX}
                    step={1}
                    value={size}
                    aria-label={t('pet.action.size')}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        setSize(next);
                        windowService.setPetSize(next);
                    }}
                />
            </section>

            <section className={styles.section}>
                <h2 className={styles.sectionTitle}>{t('pet.panel.behavior')}</h2>
                <button
                    type="button"
                    className={styles.switchRow}
                    role="switch"
                    aria-checked={roam}
                    onClick={() => {
                        const next = !roam;
                        setRoam(next);
                        windowService.setPetRoam(next);
                    }}
                >
                    <span>{roam ? t('pet.action.roamStop') : t('pet.action.roamStart')}</span>
                    <span className={styles.switch} data-on={roam} aria-hidden="true">
                        <i/>
                    </span>
                </button>
                <button type="button" className={styles.hide} onClick={() => void hidePet()}>
                    {t('pet.action.hide')}
                </button>
            </section>
        </div>
    );
}

export default PetPanelApp;
