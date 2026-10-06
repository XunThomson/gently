import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {IconPlay} from '../../../components/ui/icon';
import type {SongRow} from '../../../types';
import styles from './HeroCard.module.css';

export interface HeroCardProps {
    /** 今日推荐曲目（榜单第一名） */
    song?: SongRow;
    onPlay: (song: SongRow) => void;
}

/** 榜单顶部的今日推荐卡片。 */
export function HeroCard({song, onPlay}: HeroCardProps) {
    const {t} = useTranslation();
    if (!song) return null;

    return (
        <section className={styles.hero}>
            <div className={styles.cover}>
                <div className={styles.disc}/>
            </div>

            <div className={styles.info}>
                <span className={styles.tag}>{t('page.ranking.heroTag')}</span>
                <h2 className={styles.title}>{song.title}</h2>
                <p className={styles.sub}>{song.artist} · {song.album}</p>

                <div className={styles.meta}>
                    <span>{t('column.duration')} {song.dur}</span>
                    <i/>
                    <span>{t('page.ranking.heat', {value: song.heat})}</span>
                </div>

                <Button variant="primary" icon={<IconPlay size={12}/>} onClick={() => onPlay(song)}>
                    {t('page.ranking.heroPlay')}
                </Button>
            </div>
        </section>
    );
}

export default HeroCard;
