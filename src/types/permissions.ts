export interface IPermissionsSettings {
    permissions?: {
        allow?: string[];
        deny?: string[];
        ask?: string[];
    };
    [key: string]: unknown;
}
