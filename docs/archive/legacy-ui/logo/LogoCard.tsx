import {LogoCardProps} from "./types.ts";


export default function LogoCard({
                                     logoContent
                                 }: LogoCardProps) {
    return (
        <div>
            <span>{logoContent ? logoContent : "Gently"}</span>
        </div>
    )
}