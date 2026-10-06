import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {useActions, useDownloadState} from '../../../store';

/** 「清理已完成」按钮：仅当存在已完成任务时可用。 */
export function ClearFinishedButton() {
    const {t} = useTranslation();
    const {clearFinished} = useActions().download;
    const {tasks} = useDownloadState();
    const finished = tasks.filter((task) => task.status === 'done').length;

    return (
        <Button size="sm" variant="ghost" disabled={finished === 0} onClick={clearFinished}>
            {t('page.download.clearFinished')}
        </Button>
    );
}

export default ClearFinishedButton;
