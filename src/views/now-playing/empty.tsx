import {useTranslation} from 'react-i18next';
import {EmptyState} from '../../components/ui/empty-state';
import {IconChevronLeft, IconMusic} from '../../components/ui/icon';
import {useNowPlayingBack} from './useNowPlayingBack';
import styles from './empty.module.css';

/** 歌词页空态：没在播时也要有「返回」，不能把用户困在沉浸式页面里。 */
export function EmptyNowPlaying() {
    const {t} = useTranslation();
    const goBack = useNowPlayingBack();
    return (
        <div className={styles.page}>
            <button
                type="button"
                className={styles.back}
                aria-label={t('common.back')}
                title={t('common.back')}
                onClick={goBack}
            >
                <IconChevronLeft size={18}/>
            </button>
            <EmptyState
                icon={<IconMusic size={32}/>}
                title={t('player.notPlaying')}
                hint={t('player.pickSong')}
            />
        </div>
    );
}

export default EmptyNowPlaying;
