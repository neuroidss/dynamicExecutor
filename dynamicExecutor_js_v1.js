// FILE: dynamicExecutor_js_v1.js v1
// Node.js version for executing LLM-generated JavaScript functions.

const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid'); // Ensure uuid is imported
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dotenv = require('dotenv');
dotenv.config();

const FUNCTION_CODE_DIR = path.join(__dirname, 'generated_functions_js');
if (!fs.existsSync(FUNCTION_CODE_DIR)) {
    fs.mkdirSync(FUNCTION_CODE_DIR);
}

const FUNCTION_CREATION_TOOL_DEFINITION_JS = {
    name: 'create_dynamic_function',
    description: 'Define and create a new asynchronous JavaScript function string that can be executed later. Takes the desired function name, a high-level description of its purpose, and a parameter schema for the function itself. The generated function code will be executed in an environment where it can call external asynchronous functions via an \'external_apis\' object, whose available functions are described by the host if provided.',
    parameters: {
        type: 'object',
        properties: {
            new_function_name: {
                type: 'string',
                description: 'The name for the new JavaScript function (use camelCase or snake_case, but prefer camelCase for JS).',
            },
            new_function_description: {
                type: 'string',
                description: 'A clear, high-level description of what the new function should achieve.',
            },
            new_function_parameters_schema: {
                type: 'object',
                description: 'A JSON schema object describing the parameters the new function will accept in its `params` argument.',
                properties: {
                    type: { type: 'string', enum: ['object'] },
                    properties: { type: 'object' },
                    required: { type: 'array', items: { type: 'string' } }
                },
                required: ['type', 'properties']
            }
        },
        required: ['new_function_name', 'new_function_description', 'new_function_parameters_schema'],
    },
};


class DynamicExecutorJS {
    constructor() {
        this.openai_client = new OpenAI({
            apiKey: process.env.GEMINI_API_KEY, 
            baseURL: process.env.OPENAI_API_BASE_URL 
        });
        this.host_api_description_getter = null;
        this.host_api_execution_dict_getter = null;
        this.is_debug = true; 
        this.MAX_SYNTAX_REPAIR_RETRIES = 3;
    }

    debug_log(...args) {
        if (this.is_debug) console.log('[DEBUG DynamicExecutorJS]', ...args);
    }

    async initialize_store_js(apiDescriptionGetter, apiExecutionDictGetter) {
        this.host_api_description_getter = apiDescriptionGetter;
        this.host_api_execution_dict_getter = apiExecutionDictGetter;
        this.debug_log("DynamicExecutorJS store initialized (file-based for demo).");
    }

    async clear_function_store_js() {
        this.debug_log(`Clearing generated JS functions from directory: ${FUNCTION_CODE_DIR}`);
        try {
            const files = fs.readdirSync(FUNCTION_CODE_DIR);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    fs.unlinkSync(path.join(FUNCTION_CODE_DIR, file));
                }
            }
            this.debug_log("Generated JS function files cleared.");
        } catch (e) {
            this.debug_log(`Error clearing generated JS function files: ${e}`);
        }
    }

    _generateJSFunctionCreationPrompt(name, description, parameters_schema, host_provided_api_description, is_repair = false, previous_code = null, error_message = null) {
        let prompt = "";
        if (is_repair) {
            prompt = `You are an expert JavaScript function generator assisting with a syntax error repair.
The JavaScript code you previously generated for the asynchronous function named \`${name}\` had an error: ${error_message}

The faulty code was:
\`\`\`javascript
${previous_code}
\`\`\`

Please correct this error and provide the complete, valid asynchronous JavaScript function code again. Review the CRITICAL instructions below.`;
        } else {
            prompt = `You are an expert JavaScript function generator. Your task is to create a single, standalone asynchronous Node.js JavaScript function string based on the provided specification.

Function Name: ${name}
High-Level Description: ${description}
Parameters Schema (for the 'params' object this function will receive):
${JSON.stringify(parameters_schema, null, 2)}

Host APIs:
The function will be executed in an environment where an 'external_apis' object is available.
Call these host APIs like: \`await external_apis.someApiName(arguments_dictionary_for_host_api);\`
Available Host APIs (in \`external_apis\` object):
${host_provided_api_description || "No specific host APIs were described for this task. If you need to call any, ensure their names and argument structures are well-known or that the function can operate without them."}

`;
        }

        prompt += `
CRITICAL Instructions for JavaScript Code Generation:
1.  Write a single asynchronous JavaScript function: \`async function ${name}(params) { ... }\`.
    - The \`params\` argument will be an object containing parameters as defined in the schema.
    - The \`external_apis\` object will be available in the function's scope (closure).
2.  The function MUST return a string. This string can be a simple message or a JSON stringified object (using \`JSON.stringify\`).
    - If you need to return structured data, return a JSON string like \`JSON.stringify({ success: true, message: "..." })\`.
    - If reporting an error from within the function logic (e.g., invalid parameters), return a string starting with "Error: " or a JSON string like \`JSON.stringify({ error: "..." })\`.
3.  Use \`await\` when calling functions from the \`external_apis\` object, as they are asynchronous. Example: \`const apiResultString = await external_apis.someHostFunction({...});\`
4.  Avoid top-level \`try...catch\` blocks for the *entire* function body, as the executor handles overarching errors. However, you *SHOULD* use \`try...catch\` for specific, fallible operations like calls to \`external_apis.someFunction(...)\` or \`JSON.parse(...)\` if you want to handle their errors gracefully *within* the function and return a custom error message (as a string). If an error within such a try/catch is not re-thrown and you handle it, ensure the function still returns a string.
5.  To parse a JSON string returned by a host API, use \`JSON.parse(result_string)\`. Example: \`const data = JSON.parse(apiResultString); if (!data.success) return JSON.stringify({error: data.error });\`
6.  To access parameters from the \`params\` object, use standard JavaScript property access: \`params.parameterName\` or \`params['parameterName']\`. For optional parameters, use \`params.parameterName || defaultValue\` or check if \`params.parameterName !== undefined\`.
7.  DO NOT include any \`require()\` calls or access \`process\`, \`fs\`, etc. These modules are not available in the sandbox environment. Functions like \`uuidv4\` (for generating UUIDs) and basic \`Math\` functions ARE available directly in the sandbox. The \`THREE\` library is NOT available. If you need vector math, implement simple helper functions for it within your generated code string or perform calculations component-wise.
8.  Output ONLY the JavaScript function code block. Do NOT include \`\`\`javascript or any other surrounding text or explanations.
9.  Ensure all paths in your function return a string.

Example Function Structure (Pay ATTENTION to async/await, direct external_apis access, JSON parsing, and error handling):
\`\`\`javascript
async function exampleTool(params) {
    // Example of simple vector math helper (if needed, THREE is not available)
    // function vecSubtract(v1, v2) { return [v1[0]-v2[0], v1[1]-v2[1], v1[2]-v2[2]]; }

    const requiredParam = params.myRequiredParam;
    const optionalParam = params.myOptionalParam || 'default value for optional';

    if (requiredParam === undefined) {
        return JSON.stringify({ error: "Missing myRequiredParam." });
    }

    let hostApiResultString;
    try {
        const argsForHostApi = { input_data: requiredParam, user_id: params.user_id_if_available };
        hostApiResultString = await external_apis.someDescribedHostFunction(argsForHostApi);
    } catch (e) {
        // Handle potential errors when calling the host API itself (e.g., network issues)
        // This error is caught, and a string is returned, so the main executor won't see it as an unhandled exception.
        return JSON.stringify({ error: \`Error during host API call: \${e.message}\`});
    }

    let hostApiData;
    try {
        hostApiData = JSON.parse(hostApiResultString);
        if (!hostApiData.success) { 
            return JSON.stringify({ error: \`Host API reported failure: \${hostApiData.error || hostApiData.message || 'Unknown API error'}\` });
        }
        return JSON.stringify({ success: true, message: \`Host API processed data: \${hostApiData.processed_info}\`});
    } catch (e) {
        return JSON.stringify({ error: \`Error parsing host API response as JSON: \${e.message}. Raw response: \${hostApiResultString}\`});
    }
}
\`\`\`

Your Task:
Generate *only* the asynchronous JavaScript function code for \`${name}\` based *exactly* on the specification provided above. Ensure correct JavaScript syntax, including async/await and object property access. All paths should return a string.
`;
        return prompt;
    }

    async create_dynamic_function(new_function_name, new_function_description, new_function_parameters_schema, host_provided_api_description_for_new_func) {
        this.debug_log(`Attempting to create JS dynamic function: ${new_function_name}`);
        if (!new_function_name || !new_function_description || !new_function_parameters_schema) {
            return "Error: Missing required arguments for JS function creation.";
        }
        if (!/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(new_function_name)) {
            return `Error: Invalid JS function name '${new_function_name}'.`;
        }

        let generated_code_string = "";
        let last_error = null;
        let sanitized_code = "";

        for (let attempt = 0; attempt < this.MAX_SYNTAX_REPAIR_RETRIES + 1; attempt++) {
            try {
                const prompt = this._generateJSFunctionCreationPrompt(
                    new_function_name, new_function_description, new_function_parameters_schema,
                    host_provided_api_description_for_new_func || (this.host_api_description_getter ? this.host_api_description_getter() : "No host APIs provided."),
                    attempt > 0, generated_code_string, last_error ? last_error.message : null
                );

                this.debug_log(`Calling LLM (${process.env.OPENAI_LLM_MODEL || "gpt-3.5-turbo"}) for JS function: ${new_function_name} (Attempt: ${attempt + 1})`);
                const response = await this.openai_client.chat.completions.create({
                    model: process.env.OPENAI_LLM_MODEL || "gpt-3.5-turbo", 
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.0
                });

                generated_code_string = response.choices[0]?.message?.content?.trim();

                if (!generated_code_string) {
                    last_error = new Error("LLM returned empty code string.");
                    this.debug_log(`LLM returned empty code string for ${new_function_name}.`);
                    continue;
                }

                sanitized_code = generated_code_string.replace(/^```javascript|```$/g, '').trim();
                this.debug_log(`Sanitized code for ${new_function_name} (Attempt ${attempt + 1}):\n${sanitized_code.substring(0, 300)}...`);

                try {
                    const vmScriptCode = `
                        let funcToCheck;
                        ${sanitized_code}
                        if (typeof ${new_function_name} === 'function') {
                            funcToCheck = ${new_function_name};
                        } else {
                            throw new Error('Generated code did not define a function named ${new_function_name}.');
                        }
                    `;
                    new vm.Script(vmScriptCode, { filename: `<syntax_check:${new_function_name}>` });
                    this.debug_log(`Syntax validation passed for ${new_function_name} on attempt ${attempt + 1}.`);
                    last_error = null; 
                    break; 
                } catch (syntaxError) {
                    this.debug_log(`SyntaxError during LLM code validation for ${new_function_name} (Attempt ${attempt + 1}): ${syntaxError.message}`);
                    last_error = syntaxError;
                    if (attempt === this.MAX_SYNTAX_REPAIR_RETRIES) {
                        console.error(`Failed to generate valid JS code after ${this.MAX_SYNTAX_REPAIR_RETRIES} retries for ${new_function_name}. Last error: ${last_error.message}`);
                    }
                    continue; 
                }
            } catch (error) {
                this.debug_log(`Error calling LLM for function ${new_function_name} (Attempt ${attempt + 1}): ${error}`);
                last_error = error;
                 if (attempt === this.MAX_SYNTAX_REPAIR_RETRIES) {
                    console.error(`Failed to generate JS code after ${this.MAX_SYNTAX_REPAIR_RETRIES} retries for ${new_function_name}. Last error: ${last_error.message}`);
                }
            }
        }

        if (last_error) { 
            const error_message = `Error: Failed to generate/validate JS code for ${new_function_name} after ${this.MAX_SYNTAX_REPAIR_RETRIES + 1} attempt(s). Last error: ${last_error.message}`;
            console.error(error_message);
            return error_message;
        }

        try {
            const funcData = {
                name: new_function_name,
                description: new_function_description,
                parameters_schema_json: JSON.stringify(new_function_parameters_schema), 
                code_string: sanitized_code, 
                is_internal_special_function: false 
            };
            const filePath = path.join(FUNCTION_CODE_DIR, `${new_function_name}.json`);
            fs.writeFileSync(filePath, JSON.stringify(funcData, null, 2));
            this.debug_log(`Stored JS function ${new_function_name} at ${filePath}`);
            return `Successfully created/updated JS dynamic function: ${new_function_name}`;
        } catch (db_error) {
            console.error(`Error storing JS function definition ${new_function_name}: ${db_error}`);
            return `Error: Failed to store JS function definition ${new_function_name}. ${db_error.message}`;
        }
    }

    async store_predefined_function_js(funcData) {
        const { name, description, parameters_schema_json, code_string } = funcData;
        if (!name || !description || !parameters_schema_json || !code_string) {
            const errorMsg = `Error: Missing required fields in funcData for ${name || 'unnamed function'}. Required: name, description, parameters_schema_json, code_string.`;
            console.error(errorMsg);
            return errorMsg;
        }
        if (!/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(name)) {
            const errorMsg = `Error: Invalid JS function name '${name}'.`;
            console.error(errorMsg);
            return errorMsg;
        }
    
        // Basic syntax validation
        try {
            const vmScriptCode = `
                let funcToCheck;
                ${code_string}
                if (typeof ${name} === 'function') {
                    funcToCheck = ${name};
                } else {
                    throw new Error('Provided code_string did not define a function named ${name}.');
                }
            `;
            new vm.Script(vmScriptCode, { filename: `<syntax_check_predefined:${name}>` });
            this.debug_log(`Syntax validation passed for predefined function ${name}.`);
        } catch (syntaxError) {
            const errorMsg = `Error: Syntax error in predefined function ${name}: ${syntaxError.message}`;
            console.error(errorMsg);
            console.error(`Faulty code for ${name}:\n${code_string.substring(0, 500)}...`);
            return errorMsg;
        }
    
        try {
            const filePath = path.join(FUNCTION_CODE_DIR, `${name}.json`);
            const dataToStore = {
                name: name,
                description: description,
                parameters_schema_json: parameters_schema_json, // Assuming it's already a JSON string
                code_string: code_string,
                is_internal_special_function: false
            };
            fs.writeFileSync(filePath, JSON.stringify(dataToStore, null, 2));
            this.debug_log(`Stored predefined JS function ${name} at ${filePath}`);
            return `Successfully stored predefined JS function: ${name}`;
        } catch (store_error) {
            const errorMsg = `Error storing predefined JS function definition ${name}: ${store_error.message}`;
            console.error(errorMsg);
            return errorMsg;
        }
    }

    async get_function_definition_js(function_name) {
        const filePath = path.join(FUNCTION_CODE_DIR, `${function_name}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const funcData = JSON.parse(fileContent);
                return {
                    ...funcData,
                    parameters_schema: JSON.parse(funcData.parameters_schema_json)
                };
            } catch (e) {
                this.debug_log(`Error reading/parsing JS function file ${function_name}:`, e);
                return null;
            }
        }
        return null;
    }

    async execute_dynamic_function(function_name, params_for_function, external_apis_dict_override = null) {
        this.debug_log(`Attempting to execute JS function: ${function_name} with params: ${JSON.stringify(params_for_function).substring(0, 100)}...`);

        if (function_name === FUNCTION_CREATION_TOOL_DEFINITION_JS.name) {
            this.debug_log(`Executing special internal JS function: ${function_name}`);
            try {
                const hostApiDesc = params_for_function.host_provided_api_description_for_new_func;
                const creationParams = { ...params_for_function };
                delete creationParams.host_provided_api_description_for_new_func;


                const requiredArgs = ['new_function_name', 'new_function_description', 'new_function_parameters_schema'];
                for (const arg of requiredArgs) {
                    if (creationParams[arg] === undefined) {
                        return `Error: Missing required parameter '${arg}' for ${function_name}.`;
                    }
                }
                return await this.create_dynamic_function(
                    creationParams.new_function_name,
                    creationParams.new_function_description,
                    creationParams.new_function_parameters_schema,
                    hostApiDesc 
                );
            } catch (error) {
                console.error(`Error executing internal JS function ${function_name}: ${error}`);
                return `Error: Failed to execute internal JS function ${function_name}. ${error.message}`;
            }
        }

        const func_def = await this.get_function_definition_js(function_name);
        if (!func_def || !func_def.code_string) {
            return `Error: JS Function '${function_name}' not found or has no code.`;
        }

        const code_string = func_def.code_string;
        const external_apis = external_apis_dict_override !== null ? external_apis_dict_override : (this.host_api_execution_dict_getter ? this.host_api_execution_dict_getter() : {});

        try {
            const sandbox = {
                params: params_for_function,
                external_apis: external_apis,
                JSON: JSON, 
                uuidv4: uuidv4, 
                Math: Math, 
                console: { 
                    log: (...args) => this.debug_log(`[GuestCode Log: ${function_name}] ${args.map(String).join(' ')}`),
                    error: (...args) => console.error(`[GuestCode ERROR: ${function_name}] ${args.map(String).join(' ')}`),
                    warn: (...args) => console.warn(`[GuestCode WARN: ${function_name}] ${args.map(String).join(' ')}`)
                },
                setTimeout, 
                clearTimeout,
                setInterval,
                clearInterval,
                Promise, 
            };

            const context = vm.createContext(sandbox);

            const wrappedCode = `
                (async () => {
                    ${code_string}
                    if (typeof ${function_name} !== 'function') {
                        throw new Error('Generated code did not define a callable function named ${function_name}. Typeof: ' + typeof ${function_name});
                    }
                    return await ${function_name}(params);
                })()
            `;

            const script = new vm.Script(wrappedCode, {
                filename: `dynamic_func_${function_name}.js`, 
                timeout: 15000, 
                breakOnSigint: true 
            });
            
            const result = await script.runInContext(context);

            if (typeof result !== 'string') {
                this.debug_log(`Warning: JS dynamic function ${function_name} returned non-string result of type ${typeof result}. Attempting to stringify. Result:`, result);
                try {
                    return JSON.stringify(result); 
                } catch (stringifyError) {
                    this.debug_log(`Error: Could not stringify non-string result from ${function_name}. Error: ${stringifyError.message}`);
                    return `Error: Dynamic function ${function_name} returned a complex object that could not be serialized. Original type: ${typeof result}`;
                }
            }
            return result; 
        } catch (exec_error) {
            console.error(`Error executing dynamic JS function '${function_name}': ${exec_error}\nTraceback: ${exec_error.stack}\nCode (first 500 chars):\n${code_string.substring(0,500)}`);
            return `Error: Failed to execute dynamic JS function ${function_name}. Details: ${exec_error.message}`;
        }
    }
}

module.exports = {
 DynamicExecutorJS,
 FUNCTION_CREATION_TOOL_DEFINITION_JS 
};

