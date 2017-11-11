// the page script which is injected into browser tabs
// to collect details of fill-able fields and auto-fill
// fields

import env = require('../lib/base/env');
import forms = require('../webui/forms');
import rpc = require('../lib/net/rpc');

function inputFieldType(typeStr: string): forms.FieldType {
    switch (typeStr.toLowerCase()) {
        case 'email':
            return forms.FieldType.Email;
        case 'password':
            return forms.FieldType.Password;
        case 'submit':
        case 'button':
            return forms.FieldType.Button;
        case 'checkbox':
        case 'radio':
            return forms.FieldType.Other;
        default:
            return forms.FieldType.Text;
    }
}

function isElementVisible(elt: Element) {
    var rect = elt.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

// Holds the details of an input field found in
// the current document or a nested frame.
interface InputField {
    element: HTMLInputElement;
    field: forms.InputField;
}

function collectFieldsInDocument(document: Document): InputField[] {
    var fieldElements = document.getElementsByTagName('input');
    var fields: InputField[] = [];
    var i = 0;

    // collect fields from current document
    for (i = 0; i < fieldElements.length; i++) {
        var elt = fieldElements.item(i);

        var field: InputField = {
            element: elt,
            field: {
                key: fields.length,
                id: elt.id,
                name: elt.name,
                type: inputFieldType(elt.type),
                placeholder: elt.placeholder,
                visible: isElementVisible(elt),
            },
        };
        var ariaAttr = elt.attributes.getNamedItem('aria-label');
        if (ariaAttr) {
            field.field.ariaLabel = ariaAttr.value;
        }
        fields.push(field);
    }

    // collect fields from embedded iframes.
    //
    // FIXME: This only works for iframes hosted at the same origin as the parent document.
    // For pages where the login form is hosted on a different domain, we'll need
    // to use a browser-specific mechanism to attach to the iframe content document
    // and retrieve input fields. We'll also need suitable security checks to verify
    // the relation between the child <iframe> and the main document.
    var frames = document.querySelectorAll('iframe');
    for (i = 0; i < frames.length; i++) {
        // in Firefox (v.32+), the contentDocument property is missing for cross-origin
        // iframes. In Chrome (v.37+), attempting to access the property results in
        // a SecurityException error
        var frame = <HTMLIFrameElement>frames.item(i);
        try {
            if (frame.contentDocument) {
                var documentFields = collectFieldsInDocument(
                    frame.contentDocument
                );
                documentFields.forEach(field => {
                    field.field.key += fields.length;
                });
                fields = fields.concat(documentFields);
            }
        } catch (ex) {
            console.error('Unable to collect fields from iframe:', ex);
        }
    }

    return fields;
}

function parentForm(input: HTMLInputElement): HTMLFormElement {
    var elt: Node = input;
    while (elt) {
        if (elt instanceof HTMLFormElement) {
            return <HTMLFormElement>elt;
        }
        elt = elt.parentNode;
    }
    return null;
}

// Populates an input field with a given value and generates
// events to enable the page's UI to update itself
function autofillField(input: HTMLInputElement, value: string) {
    input.value = value;

    // some pages disable the login action on a form until
    // the user edits the username/password fields.
    //
    // Generate events that simulate those that would be generated
    // if the user filled the form manually.
    //
    // See http://stackoverflow.com/questions/1948332 for an example
    // of the kind of logic that pages may employ to detect changes
    //
    let changeEvents = [new Event('input'), new Event('change')];

    for (let event of changeEvents) {
        input.dispatchEvent(event);
    }

    return true;
}

interface InputForm {
    formElement: HTMLFormElement;
    fieldGroup: forms.FieldGroup;
}

/** Sets up communication between the content script
 * with access to the DOM of the page that the user
 * wants to autofill and the main app that stores
 * login credentials and other items, using @p portRpc
 * to communicate between the two.
 */
export function init(portRpc?: rpc.RpcHandler) {
    // Set of fields returned in the most recent RPC call
    // from the extension to collect the set of fields in the
    // document
    let lastFields: HTMLInputElement[] = [];

    if (!portRpc) {
        portRpc = new rpc.RpcHandler(new rpc.ChromeMessagePort());
    }

    portRpc.on('find-fields', () => {
        lastFields = [];

        var inputFields = collectFieldsInDocument(document);
        lastFields = inputFields.map(field => {
            return field.element;
        });

        var forms: InputForm[] = [];
        inputFields.forEach(field => {
            var formElement = parentForm(field.element);
            var form: InputForm;
            for (var i = 0; i < forms.length; i++) {
                if (forms[i].formElement === formElement) {
                    form = forms[i];
                }
            }
            if (!form) {
                form = {
                    formElement: formElement,
                    fieldGroup: { fields: [] },
                };
                forms.push(form);
            }
            form.fieldGroup.fields.push(field.field);
        });
        return forms.map(form => {
            return form.fieldGroup;
        });
    });

    portRpc.on('autofill', (entries: forms.AutoFillEntry[]) => {
        var filled = 0;

        entries.forEach(entry => {
            let foundField = false;
            if (
                typeof entry.key == 'number' &&
                entry.key >= 0 &&
                entry.key < lastFields.length
            ) {
                var elt = lastFields[entry.key];
                if (autofillField(elt, entry.value)) {
                    ++filled;
                    foundField = true;
                }
            }
            if (!foundField) {
                console.warn('Failed to find input field to autofill');
            }
        });

        return filled;
    });
}

// when this script is loaded into the page in the context
// of a browser extension, it auto-initializes itself, otherwise
// the injector has to call init() and provide an rpc.RpcHandler
// implementation to communicate with the main app that stores
// login details
if (env.isChromeExtension() || (typeof self === 'object' && 'port' in self)) {
    init();
}
