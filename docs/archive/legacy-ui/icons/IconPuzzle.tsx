const IconPuzzle = ({size = 18}: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
         strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 3v4a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2h2Zm0 0h4a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V5a2 2 0 0 0-2-2h-4"/>
        <path d="M4 10h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10Z"/>
        <path d="M10 14v4M14 14v4"/>
    </svg>
);


export default IconPuzzle;