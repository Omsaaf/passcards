import item_store = require('./item_store');

// Check the details for an item. If any possible errors are found, prompt() is invoked
// to prompt the user
export function repairItem(
    item: item_store.Item,
    reportError: (err: string) => void,
    prompt: () => Promise<boolean>
): Promise<void> {
    return item.getContent().then(content => {
        // item URLs are stored in the overview data and encrypted
        // in the content. Check that the URLs in the overview data
        // match those in the encrypted content
        var expectedLocation =
            content.urls.length > 0 ? content.urls[0].url : '';
        var wasRepaired = false;
        if (item.primaryLocation() != expectedLocation) {
            reportError(`${item.title}:`);
            reportError(
                `  Location mismatch. Actual "${item.primaryLocation()}", expected "${
                    expectedLocation
                }"`
            );

            item.locations = [];
            content.urls.forEach(url => {
                item.locations.push(url.url);
            });
            wasRepaired = true;
        }

        if (!wasRepaired) {
            return undefined;
        }

        return prompt().then(doRepair => {
            if (doRepair) {
                return item.save();
            } else {
                return null;
            }
        });
    });
}
