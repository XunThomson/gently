import {ActionsPanel} from '../../../components/shell/player-bar';
import {PlaybackModes} from '../../../components/shell/mobile/PlaybackModes';
import {PlaybackOptions} from '../../../components/shell/mobile/PlaybackOptions';
import styles from '../now-playing.module.css';

/**
 * 「播放」工具格（R143）。
 *
 * 从播放条收敛过来的功能都在这里：播放模式 / 定时关闭（`PlaybackModes`）、
 * 收藏 / 下载 / 加入歌单（`ActionsPanel inline`）、音源 / 音质（`PlaybackOptions`）。
 * 三块都是既有实现，不复制逻辑——播放条与歌词页共用同一批 action。
 */
export function PlaybackTools({onCollapse}: {onCollapse: () => void}) {
    return (
        <div className={styles.playbackTools}>
            <PlaybackModes/>

            <div className={styles.toolDivider}/>

            <ActionsPanel inline showDetail={false} onClose={onCollapse}/>

            <div className={styles.toolDivider}/>

            <PlaybackOptions/>
        </div>
    );
}

export default PlaybackTools;
