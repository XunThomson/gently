import {Component, type ErrorInfo, type ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import {Button} from '../button';
import {reportFatalError} from '../../../utils/errorOverlay';
import styles from './route-error.module.css';

interface RouteErrorState {
    error: Error | null;
}

/**
 * 路由内容区的错误边界（R137）。
 *
 * 为什么必须有：React 里**渲染期抛错会卸载整棵子树**，用户看到的就是一片白（本机设置页
 * 出现过「改一项设置后白屏」，但现场拿不到任何信息）。边界把白屏换成一句人话 + 出错信息 +
 * 「重新加载」，并 `console.error` 一行，排查时至少有东西可看。
 *
 * 放在**外壳里面、路由内容外面**：外壳（导航 / 播放条）继续可用，用户能切到别的页面；
 * 调用方用 `key={location.pathname}` 让换页自动复位。
 */
export class RouteError extends Component<{children: ReactNode}, RouteErrorState> {
    state: RouteErrorState = {error: null};

    static getDerivedStateFromError(error: Error): RouteErrorState {
        return {error};
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // 控制台（真机 CDP 可读）留一条；不做上报（ADR-0003：没有服务器）
        console.error('[route-error]', error, info.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return <RouteErrorFallback error={this.state.error} onRetry={() => this.setState({error: null})}/>;
    }
}

function RouteErrorFallback({error, onRetry}: {error: Error; onRetry: () => void}) {
    const {t} = useTranslation();
    return (
        <div className={styles.page} role="alert">
            <p className={styles.title}>{t('routeError.title')}</p>
            <p className={styles.hint}>{t('routeError.hint')}</p>
            <div className={styles.actions}>
                <Button variant="primary" size="sm" onClick={onRetry}>
                    {t('routeError.retry')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
                    {t('routeError.reload')}
                </Button>
            </div>
            {/* 出错信息折叠起来：用户默认只看到人话，反馈问题时再展开 */}
            <details className={styles.details}>
                <summary>{t('routeError.details')}</summary>
                <pre className={styles.message}>{error.message}</pre>
            </details>
        </div>
    );
}

export default RouteError;

/**
 * 整棵树的兜底边界（R137）。
 *
 * 比 `RouteError` 更外面一层：连 `ThemeProvider` / 路由内核这种「外壳之上」的渲染期错误也能兜住。
 * 这里**不渲染 React 内容**（此时主题变量与样式表都可能不可用，渲染什么都可能是白字白底），
 * 而是把错误交给 `utils/errorOverlay` 的原生面板——那一层自带内联配色，永远可读、可复制。
 */
export class RootError extends Component<{children: ReactNode}, {failed: boolean}> {
    state = {failed: false};

    static getDerivedStateFromError() {
        return {failed: true};
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        reportFatalError(
            '应用出错了',
            `${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}\n${location.href}`,
        );
    }

    render() {
        return this.state.failed ? null : this.props.children;
    }
}