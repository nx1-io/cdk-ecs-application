export const toCamel = (str: string) => {
    return str.replace(/([-_][a-z])/ig, ($1) => {
        return $1.toUpperCase()
            .replace('-', '')
            .replace('_', '');
    });
};

export const capitalizeFirstLetter = (str: string) => {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export const sliceWord = (str: string, count: number) => {
    return str.slice(0, count) + (str.length > count ? "..." : "");
}